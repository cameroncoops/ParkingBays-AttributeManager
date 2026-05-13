import { loadArcGISJSAPIModules } from 'jimu-arcgis'
import { ATTRIBUTE_TRANSACTIONS_TABLE_URL, GP_POLL_INTERVAL_MS, GP_POLL_TIMEOUT_MS, REBUILD_GP_TASK_URL } from './service-urls'
import { buildGuid, buildSqlInClause, escapeSqlValue, normaliseNullableText } from './field-helpers'

const ATTRIBUTE_TRANSACTION_OUT_FIELDS = [
  'OBJECTID',
  'record_id',
  'transaction_group_id',
  'feature_uid',
  'baytype',
  'status',
  'parkaid_zone',
  'transaction_type',
  'transaction_status',
  'transaction_date',
  'valid_from',
  'valid_to',
  'supersedes_record_id',
  'superseded_by_record_id',
  'amend_reason',
  'notes',
  'source_dwg'
]

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}

export interface AttributeTransactionRow {
  objectId: number
  recordId: string
  featureUid: string
  baytype: string | null
  status: string | null
  parkaidZone: string | null
  transactionType: string
  transactionStatus: string
  transactionDate: number
  validFrom: number
  validTo: number | null
  supersedesRecordId: string | null
  supersededByRecordId: string | null
  amendReason: string | null
  notes: string | null
  sourceDwg: string | null
}

export interface AttributeFormValues {
  baytype: string
  status: string
  parkaidZone: string
  validFrom: string
  amendReason: string
  notes: string
}

export interface AttributeTransactionAddFeature {
  attributes: {
    record_id: string
    transaction_group_id: string
    feature_uid: string
    baytype: string | null
    status: string | null
    parkaid_zone: string | null
    transaction_type: string
    transaction_status: string
    transaction_date: number
    valid_from: number
    valid_to: null
    supersedes_record_id: string
    superseded_by_record_id: null
    amend_reason: string | null
    notes: string | null
    source_dwg: string | null
  }
}

export interface AttributeTransactionUpdateFeature {
  attributes: {
    OBJECTID: number
    transaction_status: string
    valid_to: number
    superseded_by_record_id: string
  }
}

export interface AttributeTransactionPlan {
  addFeatures: AttributeTransactionAddFeature[]
  updateFeatures: AttributeTransactionUpdateFeature[]
  transactionGroupId: string
}

const toNullableString = (value: any): string | null => {
  if (value === null || value === undefined) {
    return null
  }

  const trimmedValue = String(value).trim()

  return trimmedValue === '' ? null : trimmedValue
}

const toRequiredNumber = (value: any, fieldName: string): number => {
  const parsedValue = Number(value)

  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Attribute transaction row is missing a numeric ${fieldName} value.`)
  }

  return parsedValue
}

const mapAttributeTransactionRow = (attributes: any): AttributeTransactionRow => {
  return {
    objectId: toRequiredNumber(attributes?.OBJECTID, 'OBJECTID'),
    recordId: String(attributes?.record_id || ''),
    featureUid: String(attributes?.feature_uid || ''),
    baytype: toNullableString(attributes?.baytype),
    status: toNullableString(attributes?.status),
    parkaidZone: toNullableString(attributes?.parkaid_zone),
    transactionType: String(attributes?.transaction_type || ''),
    transactionStatus: String(attributes?.transaction_status || ''),
    transactionDate: toRequiredNumber(attributes?.transaction_date, 'transaction_date'),
    validFrom: toRequiredNumber(attributes?.valid_from, 'valid_from'),
    validTo: attributes?.valid_to === null || attributes?.valid_to === undefined ? null : toRequiredNumber(attributes?.valid_to, 'valid_to'),
    supersedesRecordId: toNullableString(attributes?.supersedes_record_id),
    supersededByRecordId: toNullableString(attributes?.superseded_by_record_id),
    amendReason: toNullableString(attributes?.amend_reason),
    notes: toNullableString(attributes?.notes),
    sourceDwg: toNullableString(attributes?.source_dwg)
  }
}

export const queryCurrentAttributeRowsByFeatureUid = async (featureUids: string[]): Promise<{ [key: string]: AttributeTransactionRow }> => {
  const trimmedFeatureUids = featureUids
    .map((value) => value.trim())
    .filter((value) => value !== '')

  if (trimmedFeatureUids.length === 0) {
    return {}
  }

  const [FeatureLayer] = await loadArcGISJSAPIModules([
    'esri/layers/FeatureLayer'
  ])

  const layer = new FeatureLayer({
    url: ATTRIBUTE_TRANSACTIONS_TABLE_URL
  })

  const query = layer.createQuery()
  query.where = `${buildSqlInClause('feature_uid', trimmedFeatureUids)} AND transaction_status = 'Current'`
  query.outFields = ATTRIBUTE_TRANSACTION_OUT_FIELDS
  query.returnGeometry = false
  query.orderByFields = ['feature_uid ASC', 'transaction_date DESC', 'OBJECTID DESC']

  const featureSet = await layer.queryFeatures(query)
  const features = featureSet?.features || []
  const rowsByFeatureUid: { [key: string]: AttributeTransactionRow } = {}
  const duplicateFeatureUids = new Set<string>()

  for (const feature of features) {
    const row = mapAttributeTransactionRow(feature?.attributes || {})

    if (row.featureUid === '') {
      continue
    }

    if (rowsByFeatureUid[row.featureUid]) {
      duplicateFeatureUids.add(row.featureUid)
      continue
    }

    rowsByFeatureUid[row.featureUid] = row
  }

  if (duplicateFeatureUids.size > 0) {
    throw new Error(`AttributeTransactions has multiple Current rows for feature_uid value(s): ${Array.from(duplicateFeatureUids).sort().join(', ')}`)
  }

  return rowsByFeatureUid
}

export const buildModificationTransactionPlan = (
  targetFeatureUids: string[],
  currentRowsByFeatureUid: { [key: string]: AttributeTransactionRow },
  formValues: AttributeFormValues,
  transactionDateMillis: number
): AttributeTransactionPlan => {
  const validFromMillis = new Date(formValues.validFrom).getTime()

  if (Number.isNaN(validFromMillis)) {
    throw new Error('valid_from is invalid.')
  }

  const addFeatures: AttributeTransactionAddFeature[] = []
  const updateFeatures: AttributeTransactionUpdateFeature[] = []
  const transactionGroupId = buildGuid()

  for (const targetFeatureUid of targetFeatureUids) {
    const currentRow = currentRowsByFeatureUid[targetFeatureUid]

    if (!currentRow) {
      throw new Error(`No Current AttributeTransactions row was found for feature_uid ${targetFeatureUid}.`)
    }

    if (currentRow.recordId.trim() === '') {
      throw new Error(`The Current AttributeTransactions row for feature_uid ${targetFeatureUid} is missing record_id.`)
    }

    const newRecordId = buildGuid()

    addFeatures.push({
      attributes: {
        record_id: newRecordId,
        transaction_group_id: transactionGroupId,
        feature_uid: targetFeatureUid,
        baytype: normaliseNullableText(formValues.baytype),
        status: normaliseNullableText(formValues.status),
        parkaid_zone: normaliseNullableText(formValues.parkaidZone),
        transaction_type: 'Modified',
        transaction_status: 'Current',
        transaction_date: transactionDateMillis,
        valid_from: validFromMillis,
        valid_to: null,
        supersedes_record_id: currentRow.recordId,
        superseded_by_record_id: null,
        amend_reason: normaliseNullableText(formValues.amendReason),
        notes: normaliseNullableText(formValues.notes),
        source_dwg: currentRow.sourceDwg
      }
    })

    updateFeatures.push({
      attributes: {
        OBJECTID: currentRow.objectId,
        transaction_status: 'Superseded',
        valid_to: validFromMillis,
        superseded_by_record_id: newRecordId
      }
    })
  }

  return {
    addFeatures,
    updateFeatures,
    transactionGroupId
  }
}

export const submitAttributeTransactionPlan = async (plan: AttributeTransactionPlan): Promise<void> => {
  const [FeatureLayer] = await loadArcGISJSAPIModules([
    'esri/layers/FeatureLayer'
  ])

  const layer = new FeatureLayer({
    url: ATTRIBUTE_TRANSACTIONS_TABLE_URL
  })

  const editResult = await layer.applyEdits({
    addFeatures: plan.addFeatures,
    updateFeatures: plan.updateFeatures
  })

  const addResults = editResult?.addFeatureResults
  const updateResults = editResult?.updateFeatureResults

  if (!Array.isArray(addResults) || addResults.length !== plan.addFeatures.length) {
    throw new Error(`Unexpected add result returned from applyEdits. Raw result: ${JSON.stringify(editResult)}`)
  }

  if (!Array.isArray(updateResults) || updateResults.length !== plan.updateFeatures.length) {
    throw new Error(`Unexpected update result returned from applyEdits. Raw result: ${JSON.stringify(editResult)}`)
  }

  for (const addResult of addResults) {
    if (addResult.error) {
      throw new Error(addResult.error.message || JSON.stringify(addResult.error))
    }
  }

  for (const updateResult of updateResults) {
    if (updateResult.error) {
      throw new Error(updateResult.error.message || JSON.stringify(updateResult.error))
    }
  }
}

export const submitGpRebuild = async (): Promise<{ jobId: string, initialJobStatus: string | null }> => {
  const [esriRequest] = await loadArcGISJSAPIModules([
    'esri/request'
  ])

  const gpResponse = await esriRequest(`${REBUILD_GP_TASK_URL}/submitJob`, {
    method: 'post',
    responseType: 'json',
    query: {
      f: 'json'
    }
  })

  const gpData = gpResponse?.data

  if (gpData?.error) {
    throw new Error(
      gpData.error.details?.join(' | ') ||
      gpData.error.message ||
      'GP service returned an error.'
    )
  }

  const jobId = gpData?.jobId

  if (!jobId) {
    throw new Error(`GP submitJob returned no jobId. Raw response: ${JSON.stringify(gpData)}`)
  }

  return {
    jobId,
    initialJobStatus: gpData?.jobStatus || null
  }
}

export const pollGpRebuild = async (
  jobId: string,
  initialJobStatus?: string | null,
  onStatusChange?: (jobStatus: string) => void
): Promise<void> => {
  const [esriRequest] = await loadArcGISJSAPIModules([
    'esri/request'
  ])

  const pollStartedAt = Date.now()
  let lastSeenStatus = initialJobStatus || 'Unknown'

  while (true) {
    if (Date.now() - pollStartedAt > GP_POLL_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for GP job ${jobId} to complete after ${GP_POLL_TIMEOUT_MS / 1000} seconds.`)
    }

    await sleep(GP_POLL_INTERVAL_MS)

    const statusResponse = await esriRequest(`${REBUILD_GP_TASK_URL}/jobs/${escapeSqlValue(jobId)}`, {
      responseType: 'json',
      query: {
        f: 'json'
      }
    })

    const statusData = statusResponse?.data

    if (statusData?.error) {
      throw new Error(
        statusData.error.details?.join(' | ') ||
        statusData.error.message ||
        'GP job status request returned an error.'
      )
    }

    const currentJobStatus = statusData?.jobStatus || 'Unknown'

    if (currentJobStatus !== lastSeenStatus) {
      lastSeenStatus = currentJobStatus
      onStatusChange?.(currentJobStatus)
    }

    if (currentJobStatus === 'esriJobSucceeded') {
      break
    }

    if (
      currentJobStatus === 'esriJobFailed' ||
      currentJobStatus === 'esriJobCancelled' ||
      currentJobStatus === 'esriJobTimedOut'
    ) {
      throw new Error(`GP rebuild job ended with status ${currentJobStatus}.`)
    }
  }
}
