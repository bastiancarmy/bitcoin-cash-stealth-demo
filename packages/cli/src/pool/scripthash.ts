import { hexToBytes, concat } from '@bch-stealth/utils';
import * as Electrum from '@bch-stealth/electrum';

export function p2pkhHash160HexToScripthashHex(hash160Hex: string): string {
  const h160 = hexToBytes(hash160Hex);
  if (h160.length !== 20) throw new Error('p2pkhHash160HexToScripthashHex: expected 20-byte hash160');
  const script = concat(hexToBytes('76a914'), h160, hexToBytes('88ac'));
  return (Electrum as any).scriptToScripthash(script);
}