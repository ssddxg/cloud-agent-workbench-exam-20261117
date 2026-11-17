// ZIP32, stored entries: bounded output size and no runtime compression dependency.
const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosTime(modifiedAt) {
  const date = modifiedAt
    ? new Date(modifiedAt)
    : new Date("1980-01-01T00:00:00Z");
  if (!Number.isFinite(date.getTime()))
    throw new Error("Invalid ZIP timestamp");
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCSeconds() >>> 1),
    date:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length > 65535)
    throw new Error("ZIP entry limit exceeded");
  const localParts = [],
    centralParts = [],
    names = new Set();
  let offset = 0;
  for (const entry of entries) {
    const { name, data } = entry;
    if (
      typeof name !== "string" ||
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.includes(":") ||
      name.startsWith("/") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      names.has(name)
    )
      throw new Error("Invalid or duplicate ZIP entry name");
    if (!Buffer.isBuffer(data))
      throw new TypeError("ZIP entry data must be a Buffer");
    const filename = Buffer.from(name, "utf8");
    if (filename.length > 65535 || data.length > 0xffffffff)
      throw new Error("ZIP32 size limit exceeded");
    names.add(name);
    const checksum = crc32(data),
      stamp = dosTime(entry.modifiedAt);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + data.length;
    if (offset > 0xffffffff) throw new Error("ZIP32 offset limit exceeded");
  }
  const directory = Buffer.concat(centralParts),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}
