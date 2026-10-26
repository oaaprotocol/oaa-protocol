// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;

/// Test-only helpers (not deployed to Base).
contract MockVoter {
    address public factoryRegistry = address(0xFAC7);
    mapping(address => address) public gauges;
    mapping(address => bool) public isAlive;
    function setGauge(address pool, address gauge, bool alive) external { gauges[pool] = gauge; isAlive[gauge] = alive; }
}

contract MockLegacyFactory {
    function getPool(address, address, int24) external pure returns (address) { return address(0); }
}

contract MockAggregator {
    int256 public answer;
    uint256 public updatedAt;
    uint256 public startedAt;
    uint8 public decimals;
    constructor(uint8 d, int256 a) { decimals = d; answer = a; updatedAt = block.timestamp; startedAt = 1; }
    function set(int256 a, uint256 u) external { answer = a; updatedAt = u; }
    function description() external pure returns (string memory) { return "ETH / USD"; }
    function setStarted(uint256 s) external { startedAt = s; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, updatedAt, 1);
    }
}

contract WETH9 {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    receive() external payable { deposit(); }
    function deposit() public payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 wad) public { require(balanceOf[msg.sender] >= wad); balanceOf[msg.sender] -= wad; msg.sender.transfer(wad); }
    function totalSupply() public view returns (uint256) { return address(this).balance; }
    function approve(address guy, uint256 wad) public returns (bool) { allowance[msg.sender][guy] = wad; emit Approval(msg.sender, guy, wad); return true; }
    function transfer(address dst, uint256 wad) public returns (bool) { return transferFrom(msg.sender, dst, wad); }
    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "WETH: balance");
        if (src != msg.sender && allowance[src][msg.sender] != uint256(-1)) { require(allowance[src][msg.sender] >= wad, "WETH: allowance"); allowance[src][msg.sender] -= wad; }
        balanceOf[src] -= wad; balanceOf[dst] += wad; emit Transfer(src, dst, wad); return true;
    }
}
