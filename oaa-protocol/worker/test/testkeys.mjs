// Public Hardhat test accounts, derived from Hardhat's well-known default mnemonic.
// These keys only exist on a local test chain. Never use them on Base mainnet.
import { HDNodeWallet } from 'ethers';
const MNEMONIC = 'test test test test test test test test test test test junk';
export const TEST_KEY = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/" + i).privateKey;
