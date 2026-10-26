import json, subprocess, sys, os
import pathlib
ROOT=pathlib.Path(__file__).resolve().parent.parent
S=os.environ.get('SLIPSTREAM', str(ROOT/'slipstream'))+'/'; Q=str(ROOT)+'/'
sources={
 'oaa/OAALaunchpad.sol':Q+'OAALaunchpad.sol',
 'oaa/OAAToken.sol':Q+'OAAToken.sol',
 'oaa/Mocks.sol':Q+'test/Mocks.sol',
 'contracts/core/CLPool.sol':S+'contracts/core/CLPool.sol',
 'contracts/core/CLFactory.sol':S+'contracts/core/CLFactory.sol',
 'contracts/periphery/NonfungiblePositionManager.sol':S+'contracts/periphery/NonfungiblePositionManager.sol',
 'contracts/periphery/SwapRouter.sol':S+'contracts/periphery/SwapRouter.sol',
}
inp={'language':'Solidity','sources':{k:{'content':open(v).read()} for k,v in sources.items()},
 'settings':{'optimizer':{'enabled':True,'runs':200},'remappings':[
   'contracts/='+S+'contracts/','@openzeppelin/='+S+'lib/openzeppelin-contracts/','@uniswap/='+S+'lib/solidity-lib/',
   'base64-sol/='+S+'lib/base64/','@nomad-xyz/='+S+'lib/ExcessivelySafeCall/','./OAAToken.sol='+Q+'OAAToken.sol'],
  'outputSelection':{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}}
r=subprocess.run([os.environ.get('SOLC','solc-0.7.6'),'--standard-json','--allow-paths','/'],input=json.dumps(inp),capture_output=True,text=True)
out=json.loads(r.stdout)
errs=[e for e in out.get('errors',[]) if e['severity']=='error']
for e in out.get('errors',[]):
    if e['severity']=='error' or 'oaa' in e.get('sourceLocation',{}).get('file',''): print(e['severity'],e['formattedMessage'][:600])
if errs: sys.exit(1)
art={}
for f,cs in out['contracts'].items():
    for n,c in cs.items():
        art[n]={'abi':c['abi'],'bytecode':'0x'+c['evm']['bytecode']['object'],'size':len(c['evm']['deployedBytecode']['object'])//2}
json.dump(art,open(str(ROOT/'artifacts.json'),'w'))
for n in ['OAALaunchpad','OAAToken','CLPool','CLFactory','NonfungiblePositionManager','SwapRouter','WETH9','MockAggregator']:
    print(n, art.get(n,{}).get('size'))
