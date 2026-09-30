const alphabet =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** Nanoid-style id, length 21, via crypto.getRandomValues. */
export function uuid(size = 21): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < size; i++) {
    id += alphabet[bytes[i]! & 63]!;
  }
  return id;
}
