export const firstValue = (attributes: any, fieldNames: string[]): string => {
  for (const fieldName of fieldNames) {
    const value = attributes?.[fieldName]

    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return String(value).trim()
    }
  }

  return ''
}

export const escapeSqlValue = (value: string): string => {
  return value.replace(/'/g, "''")
}

export const buildSqlInClause = (fieldName: string, values: string[]): string => {
  return `${fieldName} IN (${values.map((value) => `'${escapeSqlValue(value)}'`).join(', ')})`
}

export const getRecordAttributes = (record: any): any => {
  return record?.getData ? record.getData() : (record?.attributes || {})
}

export const buildGuid = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return `gid-${Date.now()}-${Math.floor(Math.random() * 1000000)}`
}

export const getTodayDateInputValue = (): string => {
  return new Date().toISOString().slice(0, 10)
}

export const parseDateInputToEpoch = (value: string): number | null => {
  const parsedDate = new Date(value)

  if (Number.isNaN(parsedDate.getTime())) {
    return null
  }

  return parsedDate.getTime()
}

export const formatEpochAsDateInput = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) {
    return ''
  }

  return new Date(value).toISOString().slice(0, 10)
}

export const normaliseNullableText = (value: string): string | null => {
  const trimmedValue = value.trim()

  return trimmedValue === '' ? null : trimmedValue
}
