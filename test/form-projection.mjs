/**
 * Test-only mirror of the form projection in `@deepseek-ai/dsh-settings`
 * (`src/schema.ts` of the installed build). Kept separate from production code
 * because client bundles cannot import Host packages; the mirror lets the
 * tests prove the plugin's Config really is projected into the volatile form
 * the settings surface serves.
 */

/** @returns whether a value is a schemastery volatile reference. */
function isVolatile(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

/** Strip runtime references from a configuration snapshot. */
export function plainConfig(value) {
  if (isVolatile(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

/** Rehydrate a schema and drop volatile/secret metadata. */
function plainSchema(schema, Schema) {
  const result = new Schema(schema.toJSON())
  const walk = node => {
    delete node.meta.volatile
    if (node.meta.role === 'secret') {
      delete node.meta.default
      delete node.meta.required
    }
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

/** @returns the volatile fields of a schema, or undefined when there are none. */
export function volatileForm(schema, Schema) {
  if (schema.meta.volatile) return plainSchema(schema, Schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child, Schema)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : Schema.object(dict)
  }
  return undefined
}

/** Project only schema-declared fields. */
export function projectForm(schema, value) {
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = value[key]
      return field === undefined ? [] : [[key, projectForm(child, field)]]
    }))
  }
  return value
}
