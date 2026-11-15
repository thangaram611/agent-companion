// Schema-less wire decoder. Length-delimited fields stay bytes: only the
// Antigravity field map decides whether they are text or nested messages.
export function decode(bytes) {
  const b = Buffer.from(bytes);
  const fields = new Map();
  let offset = 0;
  function varint() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= b.length) throw new Error('truncated protobuf varint');
      const byte = b[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('oversized protobuf varint');
  }
  while (offset < b.length) {
    const tag = Number(varint());
    const number = Math.floor(tag / 8), wire = tag & 7;
    if (!number) throw new Error('invalid protobuf field zero');
    let value;
    if (wire === 0) value = varint();
    else {
      const length = wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? Number(varint()) : -1;
      if (length < 0) throw new Error(`unsupported protobuf wire type ${wire}`);
      if (!Number.isSafeInteger(length) || offset + length > b.length) throw new Error('truncated protobuf field');
      value = b.subarray(offset, offset + length); offset += length;
    }
    const values = fields.get(number) ?? [];
    values.push({ wire, value }); fields.set(number, values);
  }
  return fields;
}
export function field(bytes, ...path) {
  let value = bytes;
  for (const number of path) {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return undefined;
    value = decode(value).get(number)?.[0]?.value;
  }
  return value;
}
