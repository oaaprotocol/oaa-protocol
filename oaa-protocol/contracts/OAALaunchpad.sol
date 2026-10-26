// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "contracts/core/libraries/TickMath.sol";
import "contracts/core/libraries/FullMath.sol";
import "contracts/core/interfaces/ICLFactory.sol";
import "contracts/periphery/interfaces/INonfungiblePositionManager.sol";
import "contracts/periphery/interfaces/ISwapRouter.sol";
import "./OAAToken.sol";

interface IWETH9Minimal {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

/// @title OAALaunchpad
/// @notice Launches fixed-supply tokens "powered by OAA" on Aerodrome Slipstream (Base):
///         - 1,000,000,000 supply, 18 decimals, nothing configurable per token
///         - single-sided liquidity (only the new token) in three ranges from ~$30k to ~$1B market cap
///         - 100% of the supply goes into the pool; the position NFTs stay in this contract forever (no withdraw)
///         - the creator may buy first, in the same transaction, for up to $200 in ETH; those tokens are locked
///           in this contract for 30 months and then unlock linearly over 12 months (claimable only by the creator)
///         - all trading fees earned by the positions are sent to the OAA treasury
contract OAALaunchpad is ReentrancyGuard {
    // ---------------------------------------------------------------- fixed rules
    uint256 public constant SUPPLY = 1_000_000_000 ether;
    int24 public constant TICK_SPACING = 2_000; // Slipstream: 1% swap fee tier
    uint256 public constant MAX_DEV_BUY_USD = 200; // whole dollars
    uint256 public constant MAX_ORACLE_AGE = 3 hours;
    uint256 public constant SEQUENCER_GRACE = 1 hours;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice Lock of the creator's first buy: 30 months cliff (913 days), then linear vesting over 12 months (365 days).
    uint256 public constant DEV_CLIFF = 913 days;
    uint256 public constant DEV_VESTING = 365 days;
    /// @notice Split of the 1% fee: 40% to the token's creator (0.4% of volume), 30% burned (0.3%), the rest to the treasury (0.3%).
    uint256 public constant CREATOR_SHARE_BPS = 4_000;
    uint256 public constant BURN_SHARE_BPS = 3_000;

    /// @dev market-cap boundaries of the three ranges in whole USD and the share of supply per range (bps)
    uint256 public constant MCAP_0 = 30_000;
    uint256 public constant MCAP_1 = 1_000_000;
    uint256 public constant MCAP_2 = 50_000_000;
    uint256 public constant MCAP_3 = 1_000_000_000;
    uint256 public constant SHARE_0 = 5_000;
    uint256 public constant SHARE_1 = 3_500;
    uint256 public constant SHARE_2 = 1_500;

    // ---------------------------------------------------------------- external contracts
    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter public immutable swapRouter;
    ICLFactory public immutable poolFactory;
    address public immutable weth;
    IAggregatorV3 public immutable ethUsdFeed;
    IAggregatorV3 public immutable sequencerFeed; // may be address(0)
    uint256 private immutable feedScale; // 10 ** feed decimals

    // ---------------------------------------------------------------- state
    address public owner;
    address public pendingOwner;
    address public treasury;
    bool public paused;

    struct Launch {
        address creator;
        address pool;
        uint256[3] positions;
        uint64 launchedAt;
        int24 startTick;
    }

    mapping(address => Launch) internal _launches;
    /// @notice Creator tokens from the first buy, held by this contract until they vest.
    struct DevLock {
        uint128 amount;
        uint128 claimed;
    }
    mapping(address => DevLock) public devLocks;
    address[] public allTokens;
    /// @notice WETH fees sent to the treasury, in total and per token (for the public buyback dashboard)
    uint256 public totalFeesWeth;
    mapping(address => uint256) public feesWeth;
    /// @notice WETH fees paid out to each creator wallet
    mapping(address => uint256) public creatorFeesWeth;

    /// @notice $OAA: the token bought back with the burn share of the WETH fees (set once by the owner)
    address public buybackToken;
    int24 public buybackTickSpacing;
    address public keeper;
    /// @notice WETH reserved for buybacks. It can only ever be spent on buying `buybackToken` for the burn address.
    uint256 public buybackReserve;
    uint256 public totalBuybackWeth;
    uint256 public totalBurned;

    event Launched(
        address indexed token,
        address indexed creator,
        address pool,
        uint256[3] positions,
        int24 startTick,
        uint256 devBuyEth,
        uint256 devBuyTokens,
        uint256 burnedDust
    );
    event FeesCollected(address indexed token, address indexed treasury, uint256 amount0, uint256 amount1);
    event FeesSplit(address indexed token, uint256 wethToCreator, uint256 wethToTreasury, uint256 wethToBuyback, uint256 tokenToCreator, uint256 tokenToTreasury, uint256 tokenBurned);
    event Buyback(uint256 wethIn, uint256 burned);
    event DevLocked(address indexed token, address indexed creator, uint256 amount, uint256 cliffEnds, uint256 vestingEnds);
    event DevClaimed(address indexed token, address indexed creator, uint256 amount);
    event BuybackTokenSet(address token, int24 tickSpacing);
    event KeeperChanged(address keeper);
    event TreasuryChanged(address treasury);
    event PausedChanged(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "QL: not owner");
        _;
    }

    constructor(
        INonfungiblePositionManager _positionManager,
        ISwapRouter _swapRouter,
        address _weth,
        IAggregatorV3 _ethUsdFeed,
        IAggregatorV3 _sequencerFeed,
        address _treasury
    ) {
        require(_treasury != address(0) && _weth != address(0) && address(_ethUsdFeed) != address(0), "QL: zero address");
        positionManager = _positionManager;
        swapRouter = _swapRouter;
        poolFactory = ICLFactory(_positionManager.factory());
        weth = _weth;
        ethUsdFeed = _ethUsdFeed;
        sequencerFeed = _sequencerFeed;
        feedScale = 10 ** uint256(_ethUsdFeed.decimals());
        require(ICLFactory(_positionManager.factory()).tickSpacingToFee(TICK_SPACING) != 0, "QL: tick spacing off");
        owner = msg.sender;
        treasury = _treasury;
        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasuryChanged(_treasury);
    }

    // ================================================================ launch
    /// @notice Launch a new token. Send ETH with the call to buy first (max $200); send 0 to skip.
    function launch(string calldata name, string calldata symbol, string calldata metadata)
        external
        payable
        nonReentrant
        returns (address token)
    {
        require(!paused, "QL: paused");
        require(bytes(name).length > 0 && bytes(name).length <= 40, "QL: name length");
        require(bytes(symbol).length > 0 && bytes(symbol).length <= 12, "QL: symbol length");
        require(bytes(metadata).length <= 2_000, "QL: metadata length");

        uint256 ethUsd = _ethUsdPrice();
        if (msg.value > 0) {
            require(FullMath.mulDiv(msg.value, ethUsd, 1 ether) <= MAX_DEV_BUY_USD * feedScale, "QL: dev buy above $200");
        }

        // CREATE2 with an unpredictable salt: nobody can pre-create the pool for the next token address
        bytes32 salt = keccak256(abi.encode(msg.sender, allTokens.length, blockhash(block.number - 1), name, symbol));
        token = address(new OAAToken{salt: salt}(name, symbol, msg.sender, metadata));
        require(poolFactory.getPool(token, weth, TICK_SPACING) == address(0), "QL: pool exists");
        bool tokenIsToken0 = token < weth;

        // range boundaries as ticks of a token0-priced pool (WETH per token)
        int24[4] memory t;
        t[0] = _tickForMcap(MCAP_0, ethUsd);
        t[1] = _tickForMcap(MCAP_1, ethUsd);
        t[2] = _tickForMcap(MCAP_2, ethUsd);
        t[3] = _tickForMcap(MCAP_3, ethUsd);
        require(t[0] < t[1] && t[1] < t[2] && t[2] < t[3], "QL: bad ranges");

        IERC20(token).approve(address(positionManager), SUPPLY);

        Launch storage l = _launches[token];
        l.creator = msg.sender;
        l.launchedAt = uint64(block.timestamp);

        uint256[3] memory amounts = [SUPPLY * SHARE_0 / 10_000, SUPPLY * SHARE_1 / 10_000, 0];
        amounts[2] = SUPPLY - amounts[0] - amounts[1];

        for (uint256 i = 0; i < 3; i++) {
            int24 lower;
            int24 upper;
            uint160 initPrice;
            if (tokenIsToken0) {
                // price rises with the tick: liquidity sits above the start price, start just below range 1
                lower = t[i];
                upper = t[i + 1];
                if (i == 0) initPrice = TickMath.getSqrtRatioAtTick(t[0]) - 1;
            } else {
                // token is token1: ticks mirror; liquidity sits below the start price, start at the top of range 1
                lower = -t[i + 1];
                upper = -t[i];
                if (i == 0) initPrice = TickMath.getSqrtRatioAtTick(-t[0]);
            }
            (uint256 tokenId,,,) = positionManager.mint(
                INonfungiblePositionManager.MintParams({
                    token0: tokenIsToken0 ? token : weth,
                    token1: tokenIsToken0 ? weth : token,
                    tickSpacing: TICK_SPACING,
                    tickLower: lower,
                    tickUpper: upper,
                    amount0Desired: tokenIsToken0 ? amounts[i] : 0,
                    amount1Desired: tokenIsToken0 ? 0 : amounts[i],
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: address(this),
                    deadline: block.timestamp,
                    sqrtPriceX96: initPrice
                })
            );
            l.positions[i] = tokenId;
        }
        l.startTick = tokenIsToken0 ? t[0] : -t[0];
        l.pool = poolFactory.getPool(token, weth, TICK_SPACING);

        // rounding dust that did not fit into the positions is burned, so nobody holds unlocked supply
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) require(IERC20(token).transfer(DEAD, dust), "QL: burn failed");

        // creator buys first, in the same transaction (nobody can trade before this)
        uint256 bought;
        if (msg.value > 0) {
            IWETH9Minimal(weth).deposit{value: msg.value}();
            IWETH9Minimal(weth).approve(address(swapRouter), msg.value);
            bought = swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: weth,
                    tokenOut: token,
                    tickSpacing: TICK_SPACING,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: msg.value,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        if (bought > 0) {
            require(bought <= type(uint128).max, "QL: amount");
            devLocks[token] = DevLock(uint128(bought), 0);
            emit DevLocked(token, msg.sender, bought, block.timestamp + DEV_CLIFF, block.timestamp + DEV_CLIFF + DEV_VESTING);
        }

        allTokens.push(token);
        emit Launched(token, msg.sender, l.pool, l.positions, l.startTick, msg.value, bought, dust);
    }

    // ================================================================ fees
    /// @notice Collects all trading fees of a token's locked positions. Anyone may call.
    ///         40% goes to the token's creator, 30% to the treasury, 30% is burned: the WETH part of the burn
    ///         share is reserved to buy back and burn $OAA, the token part is sent to the burn address directly.
    function collectFees(address token) public nonReentrant returns (uint256 amount0, uint256 amount1) {
        Launch storage l = _launches[token];
        require(l.pool != address(0), "QL: unknown token");
        for (uint256 i = 0; i < 3; i++) {
            (uint256 a0, uint256 a1) = positionManager.collect(
                INonfungiblePositionManager.CollectParams({
                    tokenId: l.positions[i],
                    recipient: address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );
            amount0 += a0;
            amount1 += a1;
        }
        bool t0 = token < weth;
        uint256 w = t0 ? amount1 : amount0;
        uint256 tk = t0 ? amount0 : amount1;
        address to = treasury;
        address cr = l.creator;
        uint256 wCr = w * CREATOR_SHARE_BPS / 10_000;
        uint256 wBurn = w * BURN_SHARE_BPS / 10_000;
        uint256 tCr = tk * CREATOR_SHARE_BPS / 10_000;
        uint256 tBurn = tk * BURN_SHARE_BPS / 10_000;
        if (w > 0) {
            totalFeesWeth += w;
            feesWeth[token] += w;
            creatorFeesWeth[cr] += wCr;
            buybackReserve += wBurn;
            if (wCr > 0) require(IERC20(weth).transfer(cr, wCr), "QL: weth transfer");
            require(IERC20(weth).transfer(to, w - wCr - wBurn), "QL: weth transfer");
        }
        if (tk > 0) {
            if (tBurn > 0) require(IERC20(token).transfer(DEAD, tBurn), "QL: burn failed");
            if (tCr > 0) require(IERC20(token).transfer(cr, tCr), "QL: token transfer");
            require(IERC20(token).transfer(to, tk - tCr - tBurn), "QL: token transfer");
            if (token == buybackToken) totalBurned += tBurn;
        }
        emit FeesCollected(token, to, amount0, amount1);
        emit FeesSplit(token, wCr, w - wCr - wBurn, wBurn, tCr, tk - tCr - tBurn, tBurn);
    }

    /// @notice Spends reserved WETH on $OAA and sends all of it to the burn address.
    ///         Only owner or keeper choose the moment and the minimum output; the WETH cannot go anywhere else.
    function buyback(uint256 wethIn, uint256 minOut) external nonReentrant returns (uint256 burned) {
        require(msg.sender == owner || msg.sender == keeper, "QL: not allowed");
        require(buybackToken != address(0), "QL: no buyback token");
        require(wethIn > 0 && wethIn <= buybackReserve, "QL: amount");
        buybackReserve -= wethIn;
        IWETH9Minimal(weth).approve(address(swapRouter), wethIn);
        burned = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: weth,
                tokenOut: buybackToken,
                tickSpacing: buybackTickSpacing,
                recipient: DEAD,
                deadline: block.timestamp,
                amountIn: wethIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        totalBuybackWeth += wethIn;
        totalBurned += burned;
        emit Buyback(wethIn, burned);
    }

    // ================================================================ creator lock
    /// @notice Creator tokens that have vested so far (claimed or not).
    function devVested(address token) public view returns (uint256) {
        DevLock storage d = devLocks[token];
        uint256 start = uint256(_launches[token].launchedAt) + DEV_CLIFF;
        if (d.amount == 0 || block.timestamp < start) return 0;
        uint256 passed = block.timestamp - start;
        if (passed >= DEV_VESTING) return d.amount;
        return uint256(d.amount) * passed / DEV_VESTING;
    }

    /// @notice Creator tokens that can be claimed right now.
    function devClaimable(address token) external view returns (uint256) {
        return devVested(token) - devLocks[token].claimed;
    }

    /// @notice Sends the vested part of the creator's first buy to the creator. Only the creator can call it.
    function claimDev(address token) external nonReentrant returns (uint256 amount) {
        Launch storage l = _launches[token];
        require(msg.sender == l.creator, "QL: not creator");
        DevLock storage d = devLocks[token];
        amount = devVested(token) - d.claimed;
        require(amount > 0, "QL: nothing to claim");
        d.claimed += uint128(amount);
        require(IERC20(token).transfer(l.creator, amount), "QL: token transfer");
        emit DevClaimed(token, l.creator, amount);
    }

    /// @notice Collect fees for several tokens in one transaction.
    function collectFeesMany(address[] calldata tokens) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            collectFees(tokens[i]);
        }
    }

    // ================================================================ views
    function getLaunch(address token)
        external
        view
        returns (address creator, address pool, uint256[3] memory positions, uint64 launchedAt, int24 startTick)
    {
        Launch storage l = _launches[token];
        return (l.creator, l.pool, l.positions, l.launchedAt, l.startTick);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Current ETH/USD price used by the launchpad (feed decimals).
    function ethUsdPrice() external view returns (uint256) {
        return _ethUsdPrice();
    }

    /// @notice Maximum ETH the creator may spend on the first buy right now.
    function maxDevBuyWei() external view returns (uint256) {
        return FullMath.mulDiv(MAX_DEV_BUY_USD * feedScale, 1 ether, _ethUsdPrice());
    }

    // ================================================================ admin (cannot touch liquidity)
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "QL: zero address");
        treasury = _treasury;
        emit TreasuryChanged(_treasury);
    }

    /// @notice Sets $OAA once. Its pool with WETH must already exist on Aerodrome Slipstream.
    function setBuybackToken(address token, int24 tickSpacing) external onlyOwner {
        require(buybackToken == address(0), "QL: already set");
        require(token != address(0) && token != weth, "QL: bad token");
        require(poolFactory.getPool(token, weth, tickSpacing) != address(0), "QL: no pool");
        buybackToken = token;
        buybackTickSpacing = tickSpacing;
        emit BuybackTokenSet(token, tickSpacing);
    }

    function setKeeper(address _keeper) external onlyOwner {
        keeper = _keeper;
        emit KeeperChanged(_keeper);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedChanged(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "QL: not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @dev Position NFTs are only ever received from the position manager and can never leave this contract.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(msg.sender == address(positionManager), "QL: unexpected NFT");
        return this.onERC721Received.selector;
    }

    // ================================================================ internal math
    function _ethUsdPrice() internal view returns (uint256) {
        if (address(sequencerFeed) != address(0)) {
            (, int256 status, uint256 startedAt,,) = sequencerFeed.latestRoundData();
            require(status == 0, "QL: sequencer down");
            require(startedAt != 0, "QL: sequencer round");
            require(block.timestamp - startedAt > SEQUENCER_GRACE, "QL: sequencer grace");
        }
        (, int256 answer,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        require(answer > 0, "QL: bad price");
        require(updatedAt + MAX_ORACLE_AGE >= block.timestamp, "QL: stale price");
        return uint256(answer);
    }

    /// @dev Tick (rounded to the tick spacing) at which a token0-priced pool (WETH per token) equals `mcapUsd`.
    ///      price = (mcapUsd / 1e9 tokens) / ethUsd ; both tokens use 18 decimals, so raw and human prices match.
    function _tickForMcap(uint256 mcapUsd, uint256 ethUsd) internal view returns (int24) {
        uint256 ratioX192 = FullMath.mulDiv(mcapUsd * feedScale, uint256(1) << 192, 1_000_000_000 * ethUsd);
        uint160 sqrtPriceX96 = uint160(_sqrt(ratioX192));
        int24 tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        int24 rounded = _roundToSpacing(tick);
        require(rounded > TickMath.MIN_TICK && rounded < TickMath.MAX_TICK, "QL: tick out of range");
        return rounded;
    }

    function _roundToSpacing(int24 tick) internal pure returns (int24) {
        int24 q = tick / TICK_SPACING;
        int24 r = tick % TICK_SPACING;
        if (r < 0) {
            q -= 1;
            r += TICK_SPACING;
        }
        if (r * 2 >= TICK_SPACING) q += 1; // nearest multiple
        return q * TICK_SPACING;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x >> 1) + 1;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) >> 1;
        }
    }
}
