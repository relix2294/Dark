/**
 * Отрисовка EAN-13 в SVG для печати этикеток (внутренние коды 200… и коды производителя).
 * Кодирование — по стандарту: левая половина по таблице чётности первой цифры, правая — код R.
 */
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13Bits(code: string): string | null {
  if (!/^\d{13}$/.test(code)) return null;
  const d = [...code].map(Number);
  const par = PARITY[d[0]!]!;
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (par[i - 1] === 'L' ? L : G)[d[i]!];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i]!];
  return bits + '101';
}

export function Ean13({ code, height = 60, module = 2 }: { code: string; height?: number; module?: number }) {
  const bits = ean13Bits(code);
  if (!bits) return <code>{code}</code>;
  const quiet = 9;
  const width = (bits.length + quiet * 2) * module;
  return (
    <svg width={width} height={height + 16} viewBox={`0 0 ${width} ${height + 16}`} role="img" aria-label={`штрихкод ${code}`}>
      <rect width={width} height={height + 16} fill="#fff" />
      {[...bits].map((b, i) => (b === '1' ? <rect key={i} x={(i + quiet) * module} y={0} width={module} height={height} fill="#000" /> : null))}
      <text x={width / 2} y={height + 13} textAnchor="middle" fontFamily="monospace" fontSize={12} fill="#000">
        {code}
      </text>
    </svg>
  );
}
