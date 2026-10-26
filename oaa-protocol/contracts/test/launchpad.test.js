const hre = require('hardhat');
const { ethers } = require('ethers');
const A = require(require('path').join(__dirname, '..', 'artifacts.json'));
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓', m); };
const Q96 = 2n ** 96n;
async function expectRevert(p, msg) { try { await (await p).wait?.(); } catch (e) { const s = String(e.shortMessage || e.message); assert(!msg || s.includes(msg), 'reverts' + (msg ? ` (${msg})` : '') + ' – ' + s.slice(0, 80)); return; } throw new Error('ASSERT: expected revert ' + msg); }

async function scenario(wethAt) {
  await hre.network.provider.send('hardhat_reset');
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const [dep, creator, alice, bob, treasury, attacker] = await Promise.all([0,1,2,3,4,5].map(i => provider.getSigner(i)));
  const deploy = async (n, ...args) => { const f = new ethers.ContractFactory(A[n].abi, A[n].bytecode, dep); const c = await f.deploy(...args); await c.waitForDeployment(); return c; };
  // WETH at a chosen address to test both token orderings
  const wtmp = await deploy('WETH9');
  const code = await provider.getCode(await wtmp.getAddress());
  await hre.network.provider.send('hardhat_setCode', [wethAt, code]);
  const weth = new ethers.Contract(wethAt, A.WETH9.abi, dep);
  const voter = await deploy('MockVoter'); const legacy = await deploy('MockLegacyFactory');
  const poolImpl = await deploy('CLPool');
  const factory = await deploy('CLFactory', await voter.getAddress(), await legacy.getAddress(), await poolImpl.getAddress());
  const npm = await deploy('NonfungiblePositionManager', await factory.getAddress(), wethAt, ethers.ZeroAddress, 'Slipstream Position NFT v1', 'CL-POS');
  const router = await deploy('SwapRouter', await factory.getAddress(), wethAt);
  const feed = await deploy('MockAggregator', 8, 3500n * 10n ** 8n);
  const seq = await deploy('MockAggregator', 0, 0); await (await seq.setStarted(1)).wait();
  const lp = await deploy('OAALaunchpad', await npm.getAddress(), await router.getAddress(), wethAt, await feed.getAddress(), await seq.getAddress(), await treasury.getAddress());
  console.log(`\n=== WETH at ${wethAt}`);
  assert((await factory.tickSpacingToFee(2000)) === 10000n, 'tick spacing 2000 = 1% fee in Slipstream');

  // dev buy above $200 must fail
  const maxWei = await lp.maxDevBuyWei();
  console.log('  max dev buy wei', ethers.formatEther(maxWei), 'ETH');
  await expectRevert(lp.connect(creator).launch('Moon', 'MOON', '{}', { value: maxWei + 10n ** 12n }), 'dev buy above $200');

  // launch with a $150 dev buy
  const devBuy = ethers.parseEther((150 / 3500).toFixed(18));
  const tx = await lp.connect(creator).launch('Moon Cat', 'MCAT', '{"description":"test"}', { value: devBuy });
  const rc = await tx.wait();
  console.log('  launch gas', rc.gasUsed.toString());
  const ev = rc.logs.map(l => { try { return lp.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'Launched');
  const tokenAddr = ev.args.token;
  const token = new ethers.Contract(tokenAddr, A.OAAToken.abi, provider);
  const isToken0 = tokenAddr.toLowerCase() < wethAt.toLowerCase();
  console.log('  token', tokenAddr, isToken0 ? '(token0)' : '(token1)');
  assert((await token.totalSupply()) === 10n ** 27n, 'supply 1,000,000,000 with 18 decimals');
  assert((await token.decimals()) === 18n, 'decimals 18');
  assert((await token.poweredBy()) === "OAA Protocol", 'poweredBy = "OAA Protocol" on-chain');
  assert((await token.creator()) === await creator.getAddress(), 'creator stored');
  const lock = await lp.devLocks(tokenAddr);
  assert((await token.balanceOf(await lp.getAddress())) === lock.amount && lock.amount > 0n && lock.claimed === 0n, 'launchpad holds exactly the locked creator tokens');
  const dl = rc.logs.map(l => { try { return lp.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'DevLocked');
  const t0s = BigInt((await provider.getBlock(rc.blockNumber)).timestamp);
  assert(dl && dl.args.cliffEnds === t0s + 913n * 86400n && dl.args.vestingEnds === t0s + (913n + 365n) * 86400n, 'DevLocked event: 30 months cliff, then 12 months vesting');
  const dust = await token.balanceOf('0x000000000000000000000000000000000000dEaD');
  console.log('  burned dust', dust.toString(), 'wei');
  const [cr, poolAddr, positions] = await lp.getLaunch(tokenAddr);
  for (const id of positions) assert((await npm.ownerOf(id)) === await lp.getAddress(), `position #${id} locked in launchpad`);
  const pool = new ethers.Contract(poolAddr, A.CLPool.abi, provider);
  const inPool = await token.balanceOf(poolAddr);
  const creatorBal = await token.balanceOf(await creator.getAddress());
  assert(creatorBal === 0n, 'creator wallet holds nothing at launch (dev buy is locked)');
  assert(inPool + lock.amount + dust === 10n ** 27n, 'all supply = pool + locked dev buy + burned dust');
  console.log('  creator bought', ethers.formatEther(lock.amount), 'tokens for', ethers.formatEther(devBuy), 'ETH (locked)');
  await expectRevert(lp.connect(creator).claimDev(tokenAddr), 'nothing to claim');

  const mcap = async () => { const s = await pool.slot0(); const p = Number(s.sqrtPriceX96) / Number(Q96); let wethPerToken = p * p; if (!isToken0) wethPerToken = 1 / wethPerToken; return wethPerToken * 3500 * 1e9; };
  const ticks = []; for (const id of positions) { const p = await npm.positions(id); ticks.push([Number(p.tickLower), Number(p.tickUpper), p.liquidity]); }
  const mc = t => { let w = Math.pow(1.0001, t); if (!isToken0) w = 1 / w; return Math.round(w * 3500 * 1e9); };
  ticks.forEach((t, i) => console.log(`  range ${i + 1}: ticks [${t[0]}, ${t[1]}]  ≈ $${mc(isToken0 ? t[0] : t[1]).toLocaleString()} → $${mc(isToken0 ? t[1] : t[0]).toLocaleString()} MC`));
  console.log('  market cap after dev buy ≈ $' + Math.round(await mcap()).toLocaleString());

  // trading by others
  const swap = async (who, inTok, outTok, amt) => {
    if (inTok === wethAt) { await (await weth.connect(who).deposit({ value: amt })).wait(); }
    await (await new ethers.Contract(inTok, A.WETH9.abi, who).approve(await router.getAddress(), amt)).wait();
    const r = new ethers.Contract(await router.getAddress(), A.SwapRouter.abi, who);
    const p = { tokenIn: inTok, tokenOut: outTok, tickSpacing: 2000, recipient: await who.getAddress(), deadline: 2n ** 40n, amountIn: amt, amountOutMinimum: 0, sqrtPriceLimitX96: 0 };
    await (await r.exactInputSingle(p)).wait();
  };
  await swap(alice, wethAt, tokenAddr, ethers.parseEther('2'));
  console.log('  after alice buys 2 ETH: MC ≈ $' + Math.round(await mcap()).toLocaleString());
  const aliceTok = await token.balanceOf(await alice.getAddress());
  await swap(alice, tokenAddr, wethAt, aliceTok / 2n);
  await swap(bob, wethAt, tokenAddr, ethers.parseEther('40'));
  console.log('  after bob buys 40 ETH: MC ≈ $' + Math.round(await mcap()).toLocaleString());

  // fees: 40% creator, 30% treasury, 30% burned (WETH part reserved for $OAA buybacks, token part burned directly)
  const T = await treasury.getAddress(), DEAD = '0x000000000000000000000000000000000000dEaD', C = await creator.getAddress();
  const tw0 = await weth.balanceOf(T); const tt0 = await token.balanceOf(T); const td0 = await token.balanceOf(DEAD); const cw0 = await weth.balanceOf(C); const ct0 = await token.balanceOf(C);
  await (await lp.connect(attacker).collectFees(tokenAddr)).wait();
  const tw = (await weth.balanceOf(T)) - tw0; const tt = (await token.balanceOf(T)) - tt0; const td = (await token.balanceOf(DEAD)) - td0; const cw = (await weth.balanceOf(C)) - cw0; const ct = (await token.balanceOf(C)) - ct0;
  const res = await lp.buybackReserve(), tot = await lp.totalFeesWeth();
  const wethIn = devBuy + ethers.parseEther('42');
  console.log(`  fees: ${ethers.formatEther(tot)} WETH (${(Number(tot) / Number(wethIn) * 100).toFixed(3)}% of ETH volume) -> creator ${(Number(cw) / Number(wethIn) * 100).toFixed(3)}%, treasury ${(Number(tw) / Number(wethIn) * 100).toFixed(3)}%, buyback reserve ${(Number(res) / Number(wethIn) * 100).toFixed(3)}%`);
  assert(tw > 0n && tt > 0n && td > 0n, 'swap fees collected (anyone can trigger); token fees split between treasury and burn address');
  assert(tot === tw + res + cw && (await lp.feesWeth(tokenAddr)) === tot && (await lp.creatorFeesWeth(C)) === cw, 'on-chain fee counters = creator + treasury + buyback reserve');
  assert(Number(tot) / Number(wethIn) > 0.0099 && Number(tot) / Number(wethIn) < 0.0101, 'without a gauge the full 1% fee is collected');
  assert(res === tot * 3000n / 10000n && cw === tot * 4000n / 10000n && Number(tw) / Number(wethIn) > 0.0029 && Number(tw) / Number(wethIn) < 0.0031, '0.4% of volume to the creator, 0.3% buyback & burn, 0.3% to the treasury');
  const tall = tt + td + ct;
  assert(td === tall * 3000n / 10000n && ct === tall * 4000n / 10000n, '40% of the token-side fees to the creator, 30% burned directly');
  // if Aerodrome ever adds a live gauge to the pool, unstaked LPs pay the gauge a share (default 10%)
  await (await voter.setGauge(poolAddr, '0x000000000000000000000000000000000000beef', true)).wait();
  const g0 = await lp.totalFeesWeth();
  await swap(alice, wethAt, tokenAddr, ethers.parseEther('5'));
  await (await lp.collectFees(tokenAddr)).wait();
  const g = (await lp.totalFeesWeth()) - g0;
  console.log(`  with a live gauge: ${(Number(g) / 5e18 * 100).toFixed(3)}% of the 5 ETH buy collected`);
  assert(Number(g) / 5e18 > 0.0089 && Number(g) / 5e18 < 0.0091, 'with gauge: 0.9% collected (10% of fee to Aerodrome voters)');
  await (await voter.setGauge(poolAddr, ethers.ZeroAddress, false)).wait();
  // buyback & burn
  await expectRevert(lp.connect(dep).buyback(1n, 0n), 'QL: no buyback token');
  await expectRevert(lp.connect(attacker).setBuybackToken(tokenAddr, 2000), 'QL: not owner');
  await (await lp.connect(dep).setBuybackToken(tokenAddr, 2000)).wait();
  await expectRevert(lp.connect(dep).setBuybackToken(tokenAddr, 2000), 'QL: already set');
  const reserve = await lp.buybackReserve();
  await expectRevert(lp.connect(attacker).buyback(reserve, 0n), 'QL: not allowed');
  await expectRevert(lp.connect(dep).buyback(reserve + 1n, 0n), 'QL: amount');
  await expectRevert(lp.connect(dep).buyback(reserve, 10n ** 40n), 'Too little received');
  const d0 = await token.balanceOf(DEAD), b0 = await lp.totalBurned();
  await (await lp.connect(dep).setKeeper(await bob.getAddress())).wait();
  await (await lp.connect(bob).buyback(reserve, 1n)).wait();
  const burned = (await token.balanceOf(DEAD)) - d0;
  assert(burned > 0n && (await lp.totalBurned()) - b0 === burned && (await lp.buybackReserve()) === 0n && (await lp.totalBuybackWeth()) === reserve, `keeper bought back ${ethers.formatEther(burned)} tokens with the reserve and they went to the burn address`);
  await (await voter.setGauge(poolAddr, ethers.ZeroAddress, false)).wait();
  // nothing can take the liquidity
  await expectRevert(npm.connect(attacker).transferFrom(await lp.getAddress(), await attacker.getAddress(), positions[0]));
  const dlp = new ethers.Contract(await npm.getAddress(), A.NonfungiblePositionManager.abi, attacker);
  await expectRevert(dlp.decreaseLiquidity({ tokenId: positions[0], liquidity: 1, amount0Min: 0, amount1Min: 0, deadline: 2n ** 40n }));
  assert(!lp.interface.fragments.some(f => f.type === 'function' && /withdraw|decrease|transferNFT|rescue|sweep/i.test(f.name)), 'launchpad has no function to remove liquidity');

  // admin + safety
  await expectRevert(lp.connect(attacker).setTreasury(await attacker.getAddress()), 'not owner');
  await (await lp.setPaused(true)).wait();
  await expectRevert(lp.connect(creator).launch('X', 'X', '', { value: 0 }), 'paused');
  await (await lp.setPaused(false)).wait();
  const now = (await provider.getBlock('latest')).timestamp;
  await (await feed.set(3500n * 10n ** 8n, now - 4 * 3600)).wait();
  await expectRevert(lp.connect(creator).launch('X', 'X', '', { value: 0 }), 'stale price');
  await (await feed.set(3500n * 10n ** 8n, now)).wait();
  await (await seq.set(1, now)).wait();
  await expectRevert(lp.connect(creator).launch('X', 'X', '', { value: 0 }), 'sequencer down');
  await (await seq.set(0, now)).wait();
  // launch without dev buy, different ETH price
  await (await feed.set(1800n * 10n ** 8n, now)).wait();
  const t2 = await (await lp.connect(alice).launch('Second', 'TWO', '', { value: 0 })).wait();
  assert(t2.status === 1, 'launch without dev buy works (ETH at $1,800)');
  assert((await lp.tokenCount()) === 2n, 'both tokens registered');
  await expectRevert(lp.connect(creator).launch('', 'X', '', { value: 0 }), 'name length');
  // creator lock: 30 months cliff, then 12 months linear vesting
  const tok2 = await lp.allTokens(1);
  assert((await lp.devLocks(tok2)).amount === 0n, 'no lock without dev buy');
  const jump = async (sec) => { await hre.network.provider.send('evm_setNextBlockTimestamp', [Number(sec)]); await hre.network.provider.send('evm_mine', []); };
  const L = lock.amount;
  await jump(t0s + 913n * 86400n - 60n);
  assert((await lp.devClaimable(tokenAddr)) === 0n, 'nothing claimable one minute before the cliff (30 months)');
  await expectRevert(lp.connect(creator).claimDev(tokenAddr), 'nothing to claim');
  await jump(t0s + 913n * 86400n + 365n * 86400n / 4n);
  const q = await lp.devClaimable(tokenAddr);
  assert(q === L / 4n || q === L / 4n - 1n || q === L / 4n + 1n, '3 months into vesting: 25% claimable');
  await expectRevert(lp.connect(attacker).claimDev(tokenAddr), 'not creator');
  console.log('  dbg', (await lp.devClaimable(tokenAddr)).toString(), (await provider.getBlock('latest')).timestamp, (await lp.getLaunch(tokenAddr))[3].toString(), t0s.toString(), (await lp.devLocks(tokenAddr)).claimed.toString());
  try { console.log('  static', (await lp.connect(creator).claimDev.staticCall(tokenAddr)).toString()); } catch (e) { console.log('  static fail', e.shortMessage); }
  try { console.log('  static latest', (await lp.connect(creator).claimDev.staticCall(tokenAddr, { blockTag: 'latest' })).toString()); } catch (e) { console.log('  static2 fail', e.shortMessage); }
  console.log('  pending ts', (await provider.send('eth_getBlockByNumber', ['pending', false])).timestamp);
  await (await lp.connect(creator).claimDev(tokenAddr, { gasLimit: 300000 })).wait();
  const got1 = (await lp.devLocks(tokenAddr)).claimed;
  assert(got1 >= q && got1 < q + L / 1000n, 'creator claimed the vested quarter');
  await jump(t0s + (913n + 365n) * 86400n + 1n);
  await (await lp.connect(creator).claimDev(tokenAddr, { gasLimit: 300000 })).wait();
  const after = await lp.devLocks(tokenAddr);
  assert(after.claimed === L && (await token.balanceOf(await lp.getAddress())) === 0n, 'after 42 months everything is claimed, launchpad holds nothing');
  await expectRevert(lp.connect(creator).claimDev(tokenAddr), 'nothing to claim');
}

(async () => {
  await scenario(ethers.getAddress('0xffffffffffffffffffffffffffffffffffffff42'));   // WETH high -> new token is token0
  await scenario(ethers.getAddress('0x0000000000000000000000000000000000000ab1'));   // WETH low  -> new token is token1
  console.log('\nALL TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
