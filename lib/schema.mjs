// lib/schema.mjs — 工具 schema 的两个基础操作（自研桥接与旧桥接共用）
//
// 为什么需要它们（都是从真实故障里长出来的）：
//   ① relaxSchema：模型常在参数里多写一个字段（例如 description）。上游扩展用 Ajv 严格校验，
//      多一个字段就判死并进入"纠正"长流程（实测 75~108 秒后仍失败）。送出前把
//      additionalProperties:false 这类封闭约束放宽，能正常拿到工具调用。
//   ② stripExtras：收回来时按调用方**原始** schema 剥掉多余字段，调用方契约不受影响。
//      注意：只剥对象属性，**绝不做类型校验、绝不猜值**；调用方明确允许额外字段
//      （additionalProperties: true 或给了子 schema）时原样保留。

export function relaxSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(relaxSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' && v === false) continue;
    if (k === 'unevaluatedProperties' && v === false) continue;
    out[k] = relaxSchema(v);
  }
  return out;
}

export function stripExtras(value, schema) {
  if (!schema || typeof schema !== 'object' || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const items = schema.items && !Array.isArray(schema.items) ? schema.items : null;
    return items ? value.map((v) => stripExtras(v, items)) : value;
  }
  if (typeof value !== 'object') return value;
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : null;
  if (!props) return value;
  const extra = schema.additionalProperties;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!(k in props)) {
      if (extra === true) out[k] = v;
      else if (extra && typeof extra === 'object') out[k] = stripExtras(v, extra);
      continue;
    }
    out[k] = stripExtras(v, props[k]);
  }
  return out;
}
