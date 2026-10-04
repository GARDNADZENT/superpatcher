// Minimal parser for Android's compiled binary XML format ("AXML"), as used
// for AndroidManifest.xml inside APKs.
// Reference: frameworks/base ResourceTypes.h/.cpp (AOSP, Apache-2.0),
// specifically ResChunk_header / ResStringPool_header / ResXMLTree_node /
// ResXMLTree_attrExt / Res_value.
//
// We don't need a general-purpose XML DOM here — just enough structural
// walking to pull out <manifest package="...">, <application android:label>,
// and any <receiver> that declares itself as a Device Admin (the standard
// android:permission="android.permission.BIND_DEVICE_ADMIN" + an
// android.app.action.DEVICE_ADMIN_ENABLED intent-filter action).

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;

const TYPE_STRING = 0x03;
const TYPE_INT_BOOLEAN = 0x12;

const DEVICE_ADMIN_PERMISSION = 'android.permission.BIND_DEVICE_ADMIN';
const DEVICE_ADMIN_ACTION = 'android.app.action.DEVICE_ADMIN_ENABLED';

function readLenUtf16(dv, offset) {
  // 1 or 2 x 16-bit units; if the high bit of the first unit is set, it's a
  // 2-unit length, combined as ((v0 & 0x7FFF) << 16) | v1.
  const v0 = dv.getUint16(offset, true);
  if (v0 & 0x8000) {
    const v1 = dv.getUint16(offset + 2, true);
    return { length: ((v0 & 0x7fff) << 16) | v1, bytesUsed: 4 };
  }
  return { length: v0, bytesUsed: 2 };
}

function readLenUtf8(dv, offset) {
  // 1 or 2 bytes; same high-bit-continuation scheme but byte-granular.
  const v0 = dv.getUint8(offset);
  if (v0 & 0x80) {
    const v1 = dv.getUint8(offset + 1);
    return { length: ((v0 & 0x7f) << 8) | v1, bytesUsed: 2 };
  }
  return { length: v0, bytesUsed: 1 };
}

function parseStringPool(dv, bytes, chunkStart) {
  // chunkStart points at the ResChunk_header of the string pool chunk.
  const headerSize = dv.getUint16(chunkStart + 2, true);
  const chunkSize = dv.getUint32(chunkStart + 4, true);
  const stringCount = dv.getUint32(chunkStart + 8, true);
  const flags = dv.getUint32(chunkStart + 16, true);
  const stringsStart = dv.getUint32(chunkStart + 20, true);
  const isUtf8 = (flags & 0x100) !== 0;

  const offsetsBase = chunkStart + headerSize;
  const strings = new Array(stringCount);
  const decoder8 = new TextDecoder('utf-8');
  const decoder16 = new TextDecoder('utf-16le');

  for (let i = 0; i < stringCount; i++) {
    const entryOffset = dv.getUint32(offsetsBase + i * 4, true);
    const strOffset = chunkStart + stringsStart + entryOffset;
    if (isUtf8) {
      // character-length prefix (ignored, UTF-8 strings are self-terminating
      // by byte length), then byte-length prefix, then the UTF-8 bytes.
      const charLen = readLenUtf8(dv, strOffset);
      const byteLenInfo = readLenUtf8(dv, strOffset + charLen.bytesUsed);
      const dataStart = strOffset + charLen.bytesUsed + byteLenInfo.bytesUsed;
      strings[i] = decoder8.decode(bytes.subarray(dataStart, dataStart + byteLenInfo.length));
    } else {
      const lenInfo = readLenUtf16(dv, strOffset);
      const dataStart = strOffset + lenInfo.bytesUsed;
      strings[i] = decoder16.decode(bytes.subarray(dataStart, dataStart + lenInfo.length * 2));
    }
  }

  return { strings, chunkEnd: chunkStart + chunkSize };
}

function resolveAttrValue(strings, rawValueIdx, dataType, data) {
  if (rawValueIdx !== 0xffffffff) {
    return { kind: 'string', value: strings[rawValueIdx] ?? null };
  }
  if (dataType === TYPE_STRING) {
    return { kind: 'string', value: strings[data] ?? null };
  }
  if (dataType === TYPE_INT_BOOLEAN) {
    return { kind: 'boolean', value: data !== 0 };
  }
  // Reference (@...), dimension, color, etc. — can't resolve without a
  // resource table; surface the raw numeric form instead of crashing.
  return { kind: 'unresolved', value: data, dataType };
}

/**
 * Parses a compiled AndroidManifest.xml buffer into a small structured
 * summary. Throws on structurally invalid input; never throws just because
 * some attribute value couldn't be resolved.
 *
 * @param {Uint8Array} bytes
 */
export function parseAndroidManifest(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw new Error('File too small to be a compiled AndroidManifest.xml.');
  const rootType = dv.getUint16(0, true);
  if (rootType !== 0x0003) {
    throw new Error('Not a compiled binary XML file (unexpected root chunk type).');
  }

  let strings = [];
  const elements = []; // flat list of { name, attrs: Map<string, {kind,value}> }
  const stack = [];

  let offset = 8; // skip the outer XML chunk's own ResChunk_header
  const end = bytes.length;

  while (offset + 8 <= end) {
    const type = dv.getUint16(offset, true);
    const headerSize = dv.getUint16(offset + 2, true);
    const size = dv.getUint32(offset + 4, true);
    if (size <= 0 || offset + size > end) break;

    if (type === RES_STRING_POOL_TYPE) {
      const res = parseStringPool(dv, bytes, offset);
      strings = res.strings;
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      // ResXMLTree_node (16 bytes: chunk header + lineNumber + comment)
      // followed by ResXMLTree_attrExt.
      const attrExtOffset = offset + headerSize;
      const nameIdx = dv.getUint32(attrExtOffset + 4, true);
      const attributeStart = dv.getUint16(attrExtOffset + 8, true);
      const attributeSize = dv.getUint16(attrExtOffset + 10, true);
      const attributeCount = dv.getUint16(attrExtOffset + 12, true);

      const attrs = new Map();
      let attrOffset = attrExtOffset + attributeStart;
      for (let i = 0; i < attributeCount; i++) {
        const aNameIdx = dv.getUint32(attrOffset + 4, true);
        const aRawValueIdx = dv.getUint32(attrOffset + 8, true);
        // Res_value: size(u16) res0(u8) dataType(u8) data(u32), starting at +12
        const aDataType = dv.getUint8(attrOffset + 14);
        const aData = dv.getUint32(attrOffset + 16, true);
        const attrName = strings[aNameIdx] ?? `#${aNameIdx}`;
        attrs.set(attrName, resolveAttrValue(strings, aRawValueIdx, aDataType, aData));
        attrOffset += attributeSize;
      }

      const name = strings[nameIdx] ?? `#${nameIdx}`;
      const el = { name, attrs, children: [] };
      elements.push(el);
      if (stack.length) stack[stack.length - 1].children.push(el);
      stack.push(el);
    } else if (type === RES_XML_END_ELEMENT_TYPE) {
      stack.pop();
    }
    // RES_XML_START_NAMESPACE_TYPE / END_NAMESPACE_TYPE / CDATA / resource
    // map: nothing we need, just skip via the chunk's own size below.

    offset += size;
  }

  const manifestEl = elements.find((e) => e.name === 'manifest');
  const packageName = manifestEl?.attrs.get('package')?.value ?? null;

  const applicationEl = elements.find((e) => e.name === 'application');
  const labelAttr = applicationEl?.attrs.get('label');
  let applicationLabel = null;
  if (labelAttr) {
    applicationLabel =
      labelAttr.kind === 'string'
        ? labelAttr.value
        : `(unresolved resource 0x${Number(labelAttr.value).toString(16)})`;
  }

  const receivers = elements
    .filter((e) => e.name === 'receiver')
    .map((e) => {
      const permission = e.attrs.get('permission');
      const hasAdminPermission = permission?.kind === 'string' && permission.value === DEVICE_ADMIN_PERMISSION;
      const hasAdminAction = elementHasDescendantAction(e, DEVICE_ADMIN_ACTION);
      return {
        name: e.attrs.get('name')?.value ?? '(unnamed)',
        permission: permission?.value ?? null,
        hasAdminPermission,
        hasAdminAction,
        isDeviceAdmin: hasAdminPermission || hasAdminAction,
      };
    });

  // Belt-and-suspenders: even if our structural walk above missed something
  // (e.g. an unusual manifest shape), the compiled string pool can only
  // contain these exact strings if they were referenced *somewhere* in the
  // source manifest, which for the permission string in particular is a
  // strong, specific signal on its own.
  const stringPoolHasAdminPermission = strings.includes(DEVICE_ADMIN_PERMISSION);
  const stringPoolHasAdminAction = strings.includes(DEVICE_ADMIN_ACTION);

  return {
    packageName,
    applicationLabel,
    receivers,
    isDeviceAdmin: receivers.some((r) => r.isDeviceAdmin) || stringPoolHasAdminPermission,
    evidence: {
      stringPoolHasAdminPermission,
      stringPoolHasAdminAction,
      receiverCount: receivers.length,
      deviceAdminReceivers: receivers.filter((r) => r.isDeviceAdmin).map((r) => r.name),
    },
  };
}

function elementHasDescendantAction(el, actionName) {
  for (const child of el.children) {
    if (child.name === 'action' && child.attrs.get('name')?.value === actionName) return true;
    if (elementHasDescendantAction(child, actionName)) return true;
  }
  return false;
}
