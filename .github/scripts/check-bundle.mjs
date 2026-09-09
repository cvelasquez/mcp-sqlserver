// Verifica que un artefacto publicable no lleve credenciales adentro.
//
// Existe porque el bundle .mcpb sí las llevaba: mcpb no respeta .gitignore,
// así que connections.json entraba entero en un archivo que después se sube a
// un release público y a Smithery.
//
//   node .github/scripts/check-bundle.mjs dist/mcp-sqlserver.mcpb

import { readFileSync, existsSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const target = process.argv[2] ?? "dist/mcp-sqlserver.mcpb";

if (!existsSync(target)) {
  console.error(`No existe ${target}. Corré: npm run build:mcpb`);
  process.exit(1);
}

/** Lee los nombres de archivo del directorio central de un ZIP. */
function zipEntries(buffer) {
  // Fin del directorio central: firma 0x06054b50, buscada desde el final
  // porque el comentario del archivo es de largo variable.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65535; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no parece un ZIP: no encontré el directorio central");

  let count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  // ZIP64: los campos de 16/32 bits vienen saturados y los reales están en el
  // registro ZIP64. Un bundle con node_modules pasa los 65535 archivos fácil.
  if (count === 0xffff || offset === 0xffffffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === 0x07064b50) {
        const zip64 = Number(buffer.readBigUInt64LE(i + 8));
        count = Number(buffer.readBigUInt64LE(zip64 + 32));
        offset = Number(buffer.readBigUInt64LE(zip64 + 48));
        break;
      }
    }
  }

  const names = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    names.push(buffer.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const names = zipEntries(readFileSync(target));

const leaks = names.filter((name) => {
  const base = name.split("/").pop();
  if (base === "connections.template.json") return false;
  return /^connections.*\.json$/.test(base) || /^\.env(\..*)?$/.test(base);
});

console.log(`${target}: ${names.length} archivos`);

if (leaks.length > 0) {
  console.error("\nCREDENCIALES EN EL BUNDLE:");
  for (const leak of leaks) console.error(`  ${leak}`);
  console.error("\nRevisá .mcpbignore antes de publicar esto.");
  process.exit(1);
}

// El manifiesto y el punto de entrada tienen que estar o el bundle no arranca.
for (const required of ["manifest.json", "index.js", "src/tools.js", "connections.template.json"]) {
  if (!names.includes(required)) {
    console.error(`falta ${required} en el bundle`);
    process.exit(1);
  }
}

console.log("sin credenciales, con manifiesto y punto de entrada");
