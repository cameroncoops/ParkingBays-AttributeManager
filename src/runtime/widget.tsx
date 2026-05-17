import {
  React,
  type AllWidgetProps,
  type DataSource,
  DataSourceComponent
} from 'jimu-core'
import {
  JimuMapViewComponent,
  type JimuMapView
} from 'jimu-arcgis'

import { buildModificationTransactionPlan, buildResolvedModificationTransactionPlan, pollGpRebuild, queryCurrentAttributeRowsByFeatureUid, submitAttributeTransactionPlan, submitGpRebuild, type AttributeTransactionPlan, type AttributeTransactionRow, type ResolvedAttributeTransactionValues } from './lib/transaction-helpers'
import { escapeSqlValue, firstValue, formatEpochAsDateInput, getRecordAttributes, getTodayDateInputValue, parseDateInputToEpoch } from './lib/field-helpers'

const { useEffect, useMemo, useRef, useState } = React

const STATUS_OPTIONS = [
  'Open',
  'Closed (Temporary)',
  'Closed (Permanent)'
]
const BATCH_STATUS_DO_NOT_CHANGE = '__DO_NOT_CHANGE__'

interface HighlightHandle {
  remove: () => void
}

interface ActiveBayOption {
  featureUid: string
  building: string
  level: string
  room: string
  type: string
  status: string
  sourceDwg: string
  label: string
}

interface MatchingMapContext {
  jsApiMapView: any
  jsApiLayerView: any
  jsApiLayer: any
}

interface BatchSelectionSummary {
  selectedCount: number
  includedCount: number
  excludedCount: number
  excludedClosedCount: number
  noCurrentAttributeCount: number
  includedFeatureUids: string[]
  missingCurrentAttributeFeatureUids: string[]
}

type BatchSelectionContextType = 'parking-lot' | 'map'

const WIDGET_VERSION = 'v2026.05.17-1.4'

const ACTIVE_LAYER_MATCH_HINTS = [
  'parkingbaystest_spatialtransactions_active',
  'parking bays',
  'spatialtransactions_active'
]

const ACTIVE_BAY_QUERY_OUT_FIELDS = [
  'feature_uid',
  'building',
  'level_',
  'room',
  'type',
  'status',
  'source_dwg'
]

const REQUIRED_MARKER = ' *'

const buildBayLabel = (bay: ActiveBayOption): string => {
  const labelParts = [
    bay.building,
    bay.level,
    bay.room,
    bay.featureUid
  ].filter((value) => value !== '')

  return labelParts.join(' - ')
}
const getNormalisedText = (value: string | null | undefined): string => {
  return String(value || '').trim()
}
const getSharedValueOrBlank = (values: string[]): string => {
  const uniqueValues = Array.from(new Set(values.map((value) => value.trim())))

  return uniqueValues.length === 1 ? uniqueValues[0] : ''
}
const buildBatchSelectionSummary = (
  selectedFeatureUids: string[],
  currentRowsByFeatureUid: { [key: string]: AttributeTransactionRow },
  excludeClosedBays: boolean
): BatchSelectionSummary => {
  const includedFeatureUids: string[] = []
  const missingCurrentAttributeFeatureUids: string[] = []
  let excludedClosedCount = 0

  for (const featureUid of selectedFeatureUids) {
    const currentRow = currentRowsByFeatureUid[featureUid]

    if (!currentRow) {
      missingCurrentAttributeFeatureUids.push(featureUid)
      continue
    }

    if (excludeClosedBays && getNormalisedText(currentRow.status) !== 'Open') {
      excludedClosedCount += 1
      continue
    }

    includedFeatureUids.push(featureUid)
  }

  return {
    selectedCount: selectedFeatureUids.length,
    includedCount: includedFeatureUids.length,
    excludedCount: selectedFeatureUids.length - includedFeatureUids.length,
    excludedClosedCount,
    noCurrentAttributeCount: missingCurrentAttributeFeatureUids.length,
    includedFeatureUids,
    missingCurrentAttributeFeatureUids
  }
}

const Widget = (props: AllWidgetProps<any>) => {
  const [activeBayDs, setActiveBayDs] = useState<DataSource | null>(null)
  const [jimuMapView, setJimuMapView] = useState<JimuMapView | null>(null)

  const [activeBays, setActiveBays] = useState<ActiveBayOption[]>([])
  const [selectedBuilding, setSelectedBuilding] = useState('')
  const [selectedFeatureUid, setSelectedFeatureUid] = useState('')
  const [selectionMode, setSelectionMode] = useState<'single' | 'batch'>('single')
  const [batchSelectedFeatureUids, setBatchSelectedFeatureUids] = useState<string[]>([])
  const [batchCurrentRowsByFeatureUid, setBatchCurrentRowsByFeatureUid] = useState<{ [key: string]: AttributeTransactionRow }>({})
  const [batchSelectionContextType, setBatchSelectionContextType] = useState<BatchSelectionContextType>('parking-lot')
  const [batchSelectionContextLabel, setBatchSelectionContextLabel] = useState('')
  const [batchMissingFeatureUidCount, setBatchMissingFeatureUidCount] = useState(0)
  const [currentAttributeRow, setCurrentAttributeRow] = useState<AttributeTransactionRow | null>(null)

  const [baytype, setBaytype] = useState('')
  const [status, setStatus] = useState('')
  const [parkaidZone, setParkaidZone] = useState('')
  const [validFrom, setValidFrom] = useState(() => {
    return getTodayDateInputValue()
  })
  const [amendReason, setAmendReason] = useState('')
  const [notes, setNotes] = useState('')
  const [excludeClosedBays, setExcludeClosedBays] = useState(false)
  const [clearNoteFromTransaction, setClearNoteFromTransaction] = useState(false)
  const [showDebug, setShowDebug] = useState(false)

  const [isLoadingBays, setIsLoadingBays] = useState(false)
  const [isLoadingCurrentRow, setIsLoadingCurrentRow] = useState(false)
  const [isLoadingBatchSelection, setIsLoadingBatchSelection] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [loadError, setLoadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [statusLine, setStatusLine] = useState('')
  const [debugLines, setDebugLines] = useState<string[]>([])
  const [successSummary, setSuccessSummary] = useState('')

  const [bayRefreshToken, setBayRefreshToken] = useState(0)
  const [currentRowRefreshToken, setCurrentRowRefreshToken] = useState(0)

  const highlightHandleRef = useRef<HighlightHandle | null>(null)
  const syncMapToFeatureRef = useRef<(featureUid: string) => Promise<void>>(async () => {})

  const clearMessages = () => {
    setSuccessSummary('')
    setSubmitError('')
    setStatusLine('')
    setDebugLines([])
  }

  const appendDebugLine = (line: string) => {
    setDebugLines((previous) => [...previous, line])
  }

  const setLiveStatus = (line: string) => {
    setStatusLine(line)
    appendDebugLine(line)
  }

  const clearMapHighlight = () => {
    if (highlightHandleRef.current) {
      highlightHandleRef.current.remove()
      highlightHandleRef.current = null
    }
  }

  const resetFormForSelectedBay = () => {
    setCurrentAttributeRow(null)
    setBaytype('')
    setStatus('')
    setParkaidZone('')
    setValidFrom(getTodayDateInputValue())
    setAmendReason('')
    setNotes('')
    setClearNoteFromTransaction(false)
  }

  const applyCurrentRowToForm = (row: AttributeTransactionRow) => {
    setCurrentAttributeRow(row)
    setBaytype(row.baytype || '')
    setStatus(row.status || '')
    setParkaidZone(row.parkaidZone || '')
    setValidFrom(getTodayDateInputValue())
    setAmendReason('')
    setNotes(row.notes || '')
    setClearNoteFromTransaction(false)
  }
  const clearBatchSelection = () => {
    setBatchSelectedFeatureUids([])
    setBatchCurrentRowsByFeatureUid({})
    setBatchSelectionContextType('parking-lot')
    setBatchSelectionContextLabel('')
    setBatchMissingFeatureUidCount(0)
    setIsLoadingBatchSelection(false)
  }
  const applyBatchRowsToForm = (rows: AttributeTransactionRow[]) => {
    setCurrentAttributeRow(null)
    setBaytype(getSharedValueOrBlank(rows.map((row) => getNormalisedText(row.baytype))))
    setStatus(getSharedValueOrBlank(rows.map((row) => getNormalisedText(row.status))))
    setParkaidZone(getSharedValueOrBlank(rows.map((row) => getNormalisedText(row.parkaidZone))))
    setValidFrom(getTodayDateInputValue())
    setAmendReason('')
    setNotes(getSharedValueOrBlank(rows.map((row) => getNormalisedText(row.notes))))
    setClearNoteFromTransaction(false)
  }

  const getMatchingMapContext = (): MatchingMapContext | null => {
    if (!jimuMapView || !activeBayDs) {
      return null
    }

    const dataSourceId =
      (props.useDataSources && props.useDataSources[0] && (props.useDataSources[0] as any).dataSourceId) ||
      (activeBayDs as any)?.id

    if (!dataSourceId) {
      return null
    }

    const jimuLayerViews = (jimuMapView as any).jimuLayerViews || {}
    const layerViewEntries = Object.values(jimuLayerViews)

    const matchingJimuLayerView = layerViewEntries.find((entry: any) => {
      const entryId = entry?.id || ''

      const layerTitle =
        entry?.layer?.title ||
        entry?.layerView?.layer?.title ||
        entry?.layerDataSource?.getLabel?.() ||
        entry?.dataSource?.getLabel?.() ||
        ''

      const entryDataSourceId =
        entry?.layerDataSourceId ||
        entry?.dataSourceId ||
        entry?.layerDataSource?.id ||
        entry?.dataSource?.id ||
        ''

      const layerUrl =
        entry?.layer?.url ||
        entry?.layerView?.layer?.url ||
        entry?.layerDataSource?.getDataSourceJson?.()?.url ||
        entry?.dataSource?.getDataSourceJson?.()?.url ||
        ''

      return (
        entryDataSourceId === dataSourceId ||
        String(entryId).includes(dataSourceId) ||
        ACTIVE_LAYER_MATCH_HINTS.some((hint) => String(layerTitle).toLowerCase().includes(hint)) ||
        ACTIVE_LAYER_MATCH_HINTS.some((hint) => String(layerUrl).toLowerCase().includes(hint))
      )
    })

    if (!matchingJimuLayerView) {
      return null
    }

    const jsApiMapView = jimuMapView.view
    const jsApiLayerView = matchingJimuLayerView.view
    const jsApiLayer = matchingJimuLayerView.layer || jsApiLayerView?.layer

    if (!jsApiMapView || !jsApiLayerView || !jsApiLayer) {
      return null
    }

    return {
      jsApiMapView,
      jsApiLayerView,
      jsApiLayer
    }
  }

  const syncMapToFeature = async (featureUid: string) => {
    const trimmedFeatureUid = featureUid.trim()

    clearMapHighlight()

    if (trimmedFeatureUid === '') {
      return
    }

    const mapContext = getMatchingMapContext()

    if (!mapContext) {
      return
    }

    try {
      const layerFields = Array.isArray(mapContext.jsApiLayer.fields) ? mapContext.jsApiLayer.fields : []
      const featureUidField =
        layerFields.find((field: any) => String(field?.name || '').toLowerCase() === 'feature_uid')?.name ||
        layerFields.find((field: any) => String(field?.name || '').toLowerCase().endsWith('.feature_uid'))?.name ||
        null

      if (!featureUidField) {
        console.warn('Could not resolve feature_uid field from map layer fields', layerFields)
        return
      }

      const query = mapContext.jsApiLayer.createQuery()
      query.where = `${featureUidField} = '${escapeSqlValue(trimmedFeatureUid)}'`
      query.outFields = ['*']
      query.returnGeometry = true

      const featureSet = await mapContext.jsApiLayer.queryFeatures(query)
      const features = featureSet?.features || []

      if (features.length === 0) {
        return
      }

      if (typeof mapContext.jsApiLayerView.highlight === 'function') {
        highlightHandleRef.current = mapContext.jsApiLayerView.highlight(features)
      }

      if (typeof mapContext.jsApiMapView.goTo === 'function') {
        await mapContext.jsApiMapView.goTo(features)
      }
    } catch (error) {
      console.warn('Failed to sync map highlight/zoom', error)
    }
  }

  const refreshActiveLayerDisplay = async () => {
    const mapContext = getMatchingMapContext()

    if (!mapContext) {
      return
    }

    try {
      if (typeof mapContext.jsApiLayer.refresh === 'function') {
        mapContext.jsApiLayer.refresh()
      }
    } catch (error) {
      console.warn('Failed to refresh active parking bays layer', error)
    }
  }

  syncMapToFeatureRef.current = syncMapToFeature

  useEffect(() => {
    const loadActiveBays = async () => {
      if (!activeBayDs) {
        return
      }

      setIsLoadingBays(true)
      setLoadError('')

      try {
        const result = await (activeBayDs as any).query({
          where: '1=1',
          outFields: ACTIVE_BAY_QUERY_OUT_FIELDS,
          pageSize: 2000
        })

        const nextActiveBays: ActiveBayOption[] = (result?.records || [])
          .map((record: any) => {
            const attributes = getRecordAttributes(record)

            const nextBay: ActiveBayOption = {
              featureUid: firstValue(attributes, ['feature_uid', 'FEATURE_UID']),
              building: firstValue(attributes, ['building', 'BUILDING']),
              level: firstValue(attributes, ['level_', 'LEVEL_']),
              room: firstValue(attributes, ['room', 'ROOM']),
              type: firstValue(attributes, ['type', 'TYPE']),
              status: firstValue(attributes, ['status', 'STATUS']),
              sourceDwg: firstValue(attributes, ['source_dwg', 'SOURCE_DWG']),
              label: ''
            }

            nextBay.label = buildBayLabel(nextBay)

            return nextBay
          })
          .filter((item: ActiveBayOption) => {
            return item.featureUid !== '' && item.building !== ''
          })
          .sort((a: ActiveBayOption, b: ActiveBayOption) => {
            if (a.building !== b.building) {
              return a.building.localeCompare(b.building, undefined, { numeric: true, sensitivity: 'base' })
            }

            if (a.level !== b.level) {
              return a.level.localeCompare(b.level, undefined, { numeric: true, sensitivity: 'base' })
            }

            if (a.room !== b.room) {
              return a.room.localeCompare(b.room, undefined, { numeric: true, sensitivity: 'base' })
            }

            return a.featureUid.localeCompare(b.featureUid, undefined, { numeric: true, sensitivity: 'base' })
          })

        setActiveBays(nextActiveBays)
      } catch (error: any) {
        setLoadError(error?.message || 'Failed to load active parking bays.')
      } finally {
        setIsLoadingBays(false)
      }
    }

    void loadActiveBays()
  }, [activeBayDs, bayRefreshToken])

  useEffect(() => {
    const loadCurrentAttributeRow = async () => {
      const trimmedFeatureUid = selectedFeatureUid.trim()

      if (trimmedFeatureUid === '') {
        resetFormForSelectedBay()
        return
      }

      setIsLoadingCurrentRow(true)
      setLoadError('')

      try {
        const rowsByFeatureUid = await queryCurrentAttributeRowsByFeatureUid([trimmedFeatureUid])
        const row = rowsByFeatureUid[trimmedFeatureUid]

        if (!row) {
          resetFormForSelectedBay()
          setLoadError(`No Current AttributeTransactions row was found for feature_uid ${trimmedFeatureUid}.`)
          return
        }

        applyCurrentRowToForm(row)
      } catch (error: any) {
        resetFormForSelectedBay()
        setLoadError(error?.message || 'Failed to load the current attribute transaction row.')
      } finally {
        setIsLoadingCurrentRow(false)
      }
    }

    void loadCurrentAttributeRow()
  }, [selectedFeatureUid, currentRowRefreshToken])

  useEffect(() => {
    if (selectedFeatureUid !== '') {
      void syncMapToFeatureRef.current(selectedFeatureUid)
      return
    }

    clearMapHighlight()
  }, [selectedFeatureUid, jimuMapView])

  useEffect(() => {
    return () => {
      clearMapHighlight()
    }
  }, [])

  const buildings = useMemo(() => {
    return Array.from(new Set(activeBays.map((item) => item.building))).sort((a, b) => {
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    })
  }, [activeBays])

  const filteredBays = useMemo(() => {
    if (selectedBuilding === '') {
      return []
    }

    return activeBays.filter((item) => item.building === selectedBuilding)
  }, [activeBays, selectedBuilding])

  const selectedBay = useMemo(() => {
    return activeBays.find((item) => item.featureUid === selectedFeatureUid) || null
  }, [activeBays, selectedFeatureUid])
  const batchSelectionSummary = useMemo(() => {
    return buildBatchSelectionSummary(
      batchSelectedFeatureUids,
      batchCurrentRowsByFeatureUid,
      excludeClosedBays
    )
  }, [batchSelectedFeatureUids, batchCurrentRowsByFeatureUid, excludeClosedBays])

  const currentRowSummaryItems = useMemo(() => {
    if (!currentAttributeRow) {
      return []
    }

    return [
      `Record ID: ${currentAttributeRow.recordId}`,
      `Bay Type: ${currentAttributeRow.baytype || '(blank)'}`,
      `Status: ${currentAttributeRow.status || '(blank)'}`,
      `Parkaid Zone: ${currentAttributeRow.parkaidZone || '(blank)'}`,
      `Valid From: ${formatEpochAsDateInput(currentAttributeRow.validFrom) || '(blank)'}`,
      `Source Dwg: ${currentAttributeRow.sourceDwg || '(blank)'}`
    ]
  }, [currentAttributeRow])

  const handleBuildingChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectionMode('single')
    setSelectedBuilding(event.target.value)
    setSelectedFeatureUid('')
    clearBatchSelection()
    clearMessages()
    resetFormForSelectedBay()
  }

  const activateTargetBay = (featureUid: string, building: string) => {
    const trimmedFeatureUid = featureUid.trim()
    const trimmedBuilding = building.trim()

    if (trimmedFeatureUid === '' || trimmedBuilding === '') {
      return
    }

    const isSameFeature = selectedFeatureUid === trimmedFeatureUid

    setSelectionMode('single')
    clearBatchSelection()
    clearMessages()
    setLoadError('')
    resetFormForSelectedBay()
    setSelectedBuilding(trimmedBuilding)
    setSelectedFeatureUid(trimmedFeatureUid)

    if (isSameFeature) {
      setCurrentRowRefreshToken(Date.now())
    }
  }

  const handleBayChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextFeatureUid = event.target.value
    const matchingBay = activeBays.find((item) => item.featureUid === nextFeatureUid)

    if (!matchingBay) {
      setSelectionMode('single')
      clearBatchSelection()
      setSelectedFeatureUid(nextFeatureUid)
      clearMessages()
      resetFormForSelectedBay()
      return
    }

    activateTargetBay(matchingBay.featureUid, matchingBay.building)
  }

  const loadSelectedBayFromMap = () => {
    if (!activeBayDs || typeof activeBayDs.getSelectedRecords !== 'function') {
      clearMessages()
      setLiveStatus('No selected bay found in the map-linked active parking bays layer.')
      return
    }

    const selectedRecords = activeBayDs.getSelectedRecords() || []

    if (selectedRecords.length === 0) {
      clearMessages()
      setLiveStatus('No selected bay found in the map-linked active parking bays layer.')
      return
    }

    const selectedMapTargets: Array<{ featureUid: string, building: string }> = []
    let missingFeatureUidCount = 0

    for (const selectedRecord of selectedRecords) {
      const selectedRecordAttributes = getRecordAttributes(selectedRecord)
      const selectedFeatureUidFromMap = firstValue(selectedRecordAttributes, ['feature_uid', 'FEATURE_UID'])
      const selectedBuildingFromMap = firstValue(selectedRecordAttributes, ['building', 'BUILDING'])
      const matchingLoadedBay = activeBays.find((item) => item.featureUid === selectedFeatureUidFromMap)

      const resolvedFeatureUid = matchingLoadedBay?.featureUid || selectedFeatureUidFromMap
      const resolvedBuilding = matchingLoadedBay?.building || selectedBuildingFromMap

      if (resolvedFeatureUid === '') {
        missingFeatureUidCount += 1
        continue
      }

      selectedMapTargets.push({
        featureUid: resolvedFeatureUid,
        building: resolvedBuilding
      })
    }

    if (selectedRecords.length === 1) {
      const selectedMapTarget = selectedMapTargets[0]

      if (!selectedMapTarget) {
        clearMessages()
        setLiveStatus('The selected map feature does not provide feature_uid.')
        return
      }

      if (selectedMapTarget.building === '') {
        clearMessages()
        setLiveStatus(`The selected map feature for feature_uid ${selectedMapTarget.featureUid} does not provide the Parking Lot value needed by the dropdown path.`)
        return
      }

      activateTargetBay(selectedMapTarget.featureUid, selectedMapTarget.building)
      setLiveStatus(`Selected bay loaded from map: ${selectedMapTarget.featureUid}`)
      appendDebugLine(`Map-selected bay loaded. feature_uid=${selectedMapTarget.featureUid}`)
      return
    }

    const uniqueFeatureUids = Array.from(new Set(selectedMapTargets.map((item) => item.featureUid)))

    if (uniqueFeatureUids.length === 0) {
      clearMessages()
      setLiveStatus(`No selected bays with feature_uid were found in the map-linked active parking bays layer. Ignored ${missingFeatureUidCount} selected record(s) with no feature_uid.`)
      return
    }

    void loadBatchSelection(
      uniqueFeatureUids,
      {
        contextType: 'map',
        contextLabel: 'selected bays from map',
        source: 'map-selected',
        missingFeatureUidCount
      }
    )
  }
  const loadBatchSelection = async (
    featureUids: string[],
    options: {
      contextType: BatchSelectionContextType
      contextLabel: string
      source: 'select-all' | 'map-selected' | 'post-submit-refresh'
      missingFeatureUidCount?: number
    }
  ) => {
    const trimmedFeatureUids = featureUids
      .map((featureUid) => featureUid.trim())
      .filter((featureUid) => featureUid !== '')
    const uniqueFeatureUids = Array.from(new Set(trimmedFeatureUids))
    const trimmedContextLabel = options.contextLabel.trim()
    const missingFeatureUidCount = options.missingFeatureUidCount || 0

    if (options.contextType === 'parking-lot' && trimmedContextLabel === '') {
      setSubmitError('A Parking Lot must be selected before batch selection can proceed.')
      return
    }

    if (uniqueFeatureUids.length === 0) {
      if (options.contextType === 'map') {
        setSubmitError('No selected bays with feature_uid were found in the map-linked active parking bays layer.')
        return
      }

      setSubmitError(`No active bays were found in Parking Lot ${trimmedContextLabel}.`)
      return
    }

    setSelectionMode('batch')
    setSelectedFeatureUid('')
    setCurrentAttributeRow(null)
    setLoadError('')
    setIsLoadingBatchSelection(true)
    setBatchSelectedFeatureUids(uniqueFeatureUids)
    setBatchCurrentRowsByFeatureUid({})
    setBatchSelectionContextType(options.contextType)
    setBatchSelectionContextLabel(trimmedContextLabel)
    setBatchMissingFeatureUidCount(missingFeatureUidCount)
    resetFormForSelectedBay()

    try {
      const rowsByFeatureUid = await queryCurrentAttributeRowsByFeatureUid(uniqueFeatureUids)
      const summary = buildBatchSelectionSummary(
        uniqueFeatureUids,
        rowsByFeatureUid,
        excludeClosedBays
      )

      setBatchCurrentRowsByFeatureUid(rowsByFeatureUid)
      applyBatchRowsToForm(
        summary.includedFeatureUids
          .map((featureUid) => rowsByFeatureUid[featureUid])
          .filter((row): row is AttributeTransactionRow => !!row)
      )

      if (options.source === 'select-all' || options.source === 'map-selected') {
        clearMessages()
      }

      if (options.contextType === 'map') {
        const statusParts = [`Selected ${summary.selectedCount} bays from map`]

        if (missingFeatureUidCount > 0) {
          statusParts.push(`Ignored ${missingFeatureUidCount} selected record(s) with no feature_uid`)
        }

        if (summary.includedCount === 0) {
          statusParts.push('No included bays remain after exclusions.')
        } else {
          statusParts.push(`Included ${summary.includedCount}.`)
        }

        setLiveStatus(statusParts.join('. '))
      } else {
        if (summary.includedCount === 0) {
          setLiveStatus(
            `Selected ${summary.selectedCount} bays in ${trimmedContextLabel}. No included bays remain after exclusions.`
          )
        } else {
          setLiveStatus(`Selected ${summary.selectedCount} bays in ${trimmedContextLabel}. Included ${summary.includedCount}.`)
        }
      }

      if (options.contextType === 'map') {
        appendDebugLine(`Map-selected batch target feature_uid list: ${uniqueFeatureUids.join(', ')}`)
      } else {
        appendDebugLine(`Batch target feature_uid list: ${uniqueFeatureUids.join(', ')}`)
      }

      if (missingFeatureUidCount > 0) {
        appendDebugLine(`Ignored ${missingFeatureUidCount} selected record(s) with no feature_uid.`)
      }

      if (summary.noCurrentAttributeCount > 0) {
        appendDebugLine(
          `Excluded ${summary.noCurrentAttributeCount} bay(s) with no Current AttributeTransactions row.`
        )
      }

      if (summary.excludedClosedCount > 0) {
        appendDebugLine(
          `Excluded ${summary.excludedClosedCount} non-Open bay(s) because Exclude Closed Bays is enabled.`
        )
      }
    } catch (error: any) {
      clearBatchSelection()
      resetFormForSelectedBay()
      setSelectionMode('single')
      setLoadError(error?.message || 'Failed to prepare the batch selection.')
    } finally {
      setIsLoadingBatchSelection(false)
    }
  }
  const selectAllBaysInParkingLot = () => {
    clearMessages()
    setLoadError('')

    if (selectedBuilding.trim() === '') {
      setSubmitError('A Parking Lot must be selected before Select All Bays can proceed.')
      return
    }

    const targetFeatureUids = filteredBays.map((bay) => bay.featureUid)
    void loadBatchSelection(
      targetFeatureUids,
      {
        contextType: 'parking-lot',
        contextLabel: selectedBuilding,
        source: 'select-all'
      }
    )
  }
  const buildBatchResolvedTransactionTargets = (
    targetFeatureUids: string[],
    currentRowsByFeatureUid: { [key: string]: AttributeTransactionRow }
  ): ResolvedAttributeTransactionValues[] => {
    const resolvedTargets: ResolvedAttributeTransactionValues[] = []
    const trimmedBaytype = baytype.trim()
    const trimmedStatus = status.trim()
    const trimmedParkaidZone = parkaidZone.trim()
    const trimmedAmendReason = amendReason.trim()
    const trimmedNotes = notes.trim()

    for (const targetFeatureUid of targetFeatureUids) {
      const currentRow = currentRowsByFeatureUid[targetFeatureUid]

      if (!currentRow) {
        throw new Error(`No Current AttributeTransactions row was found for feature_uid ${targetFeatureUid}.`)
      }

      const resolvedBaytype =
        trimmedBaytype !== '' ? trimmedBaytype : getNormalisedText(currentRow.baytype)
      const resolvedStatus =
        trimmedStatus !== '' && trimmedStatus !== BATCH_STATUS_DO_NOT_CHANGE
          ? trimmedStatus
          : getNormalisedText(currentRow.status)
      const resolvedParkaidZone =
        trimmedParkaidZone !== '' ? trimmedParkaidZone : getNormalisedText(currentRow.parkaidZone)
      const resolvedNotes = clearNoteFromTransaction
        ? ''
        : trimmedNotes !== ''
          ? trimmedNotes
          : getNormalisedText(currentRow.notes)

      if (resolvedBaytype === '') {
        throw new Error(`feature_uid ${targetFeatureUid} has no Bay Type value to carry forward.`)
      }

      if (resolvedStatus === '') {
        throw new Error(`feature_uid ${targetFeatureUid} has no Status value to carry forward.`)
      }

      if (resolvedParkaidZone === '') {
        throw new Error(`feature_uid ${targetFeatureUid} has no Parkaid Zone value to carry forward.`)
      }

      resolvedTargets.push({
        featureUid: targetFeatureUid,
        baytype: resolvedBaytype,
        status: resolvedStatus,
        parkaidZone: resolvedParkaidZone,
        amendReason: trimmedAmendReason,
        notes: resolvedNotes
      })
    }

    return resolvedTargets
  }
  const batchSelectionHasActualChange = (
    resolvedTargets: ResolvedAttributeTransactionValues[],
    currentRowsByFeatureUid: { [key: string]: AttributeTransactionRow }
  ): boolean => {
    return resolvedTargets.some((resolvedTarget) => {
      const currentRow = currentRowsByFeatureUid[resolvedTarget.featureUid]

      if (!currentRow) {
        return false
      }

      return (
        resolvedTarget.baytype !== getNormalisedText(currentRow.baytype) ||
        resolvedTarget.status !== getNormalisedText(currentRow.status) ||
        resolvedTarget.parkaidZone !== getNormalisedText(currentRow.parkaidZone) ||
        resolvedTarget.notes !== getNormalisedText(currentRow.notes)
      )
    })
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isSubmitting) {
      return
    }

    clearMessages()
    setLoadError('')

    if (validFrom.trim() === '') {
      setSubmitError('valid_from is required before submit can proceed.')
      return
    }

    if (parseDateInputToEpoch(validFrom) === null) {
      setSubmitError('valid_from is invalid.')
      return
    }

    const transactionDateMillis = Date.now()

    setIsSubmitting(true)
    setLiveStatus('Preparing attribute transaction...')

    try {
      let plan: AttributeTransactionPlan
      let targetFeatureUids: string[] = []
      let successTargetLabel = ''

      if (selectionMode === 'batch') {
        targetFeatureUids = [...batchSelectionSummary.includedFeatureUids]

        if (targetFeatureUids.length === 0) {
          setSubmitError('No included target bays remain after exclusions.')
          return
        }

        if (batchSelectionContextType === 'parking-lot') {
          appendDebugLine(`Selected parking lot: ${batchSelectionContextLabel}`)
        } else {
          appendDebugLine('Selected map batch source: active parking bays datasource selection')
        }

        appendDebugLine(`Batch target feature_uid list: ${targetFeatureUids.join(', ')}`)

        const latestRowsByFeatureUid = await queryCurrentAttributeRowsByFeatureUid(targetFeatureUids)
        const resolvedTargets = buildBatchResolvedTransactionTargets(
          targetFeatureUids,
          latestRowsByFeatureUid
        )

        if (!batchSelectionHasActualChange(resolvedTargets, latestRowsByFeatureUid)) {
          setSubmitError('No actual attribute change was detected for the included target bays.')
          return
        }

        const confirmationLines = [
          `You are about to update ${targetFeatureUids.length} bays. Continue?`
        ]

        if (batchSelectionContextType === 'parking-lot' && batchSelectionContextLabel !== '') {
          confirmationLines.push(`Parking Lot: ${batchSelectionContextLabel}`)
        }

        if (batchMissingFeatureUidCount > 0) {
          confirmationLines.push(
            `${batchMissingFeatureUidCount} selected record(s) will be ignored because they do not provide feature_uid.`
          )
        }

        if (batchSelectionSummary.noCurrentAttributeCount > 0) {
          confirmationLines.push(
            `${batchSelectionSummary.noCurrentAttributeCount} bay(s) will be excluded because they have no Current AttributeTransactions row.`
          )
        }

        if (batchSelectionSummary.excludedClosedCount > 0) {
          confirmationLines.push(
            `${batchSelectionSummary.excludedClosedCount} bay(s) will be excluded because Exclude Closed Bays is enabled.`
          )
        }

        if (!window.confirm(confirmationLines.join('\n'))) {
          setLiveStatus('Batch submit cancelled.')
          return
        }

        setLiveStatus('Building batch transaction plan...')
        plan = buildResolvedModificationTransactionPlan(
          resolvedTargets,
          latestRowsByFeatureUid,
          validFrom,
          transactionDateMillis
        )
        successTargetLabel = batchSelectionContextType === 'map'
          ? `${targetFeatureUids.length} selected bay${targetFeatureUids.length === 1 ? '' : 's'} from map`
          : `${targetFeatureUids.length} bays in ${batchSelectionContextLabel}`

        appendDebugLine(`Included target count: ${targetFeatureUids.length}`)
        appendDebugLine(`Missing feature_uid count: ${batchMissingFeatureUidCount}`)
        appendDebugLine(`Excluded closed count: ${batchSelectionSummary.excludedClosedCount}`)
        appendDebugLine(`No-current-attribute count: ${batchSelectionSummary.noCurrentAttributeCount}`)
      } else {
        const trimmedFeatureUid = selectedFeatureUid.trim()

        if (trimmedFeatureUid === '') {
          setSubmitError('A selected feature_uid is required before submit can proceed.')
          return
        }

        if (!currentAttributeRow) {
          setSubmitError('A Current AttributeTransactions row is required before submit can proceed.')
          return
        }

        if (baytype.trim() === '') {
          setSubmitError('Bay Type is required before submit can proceed.')
          return
        }

        if (status.trim() === '') {
          setSubmitError('Status is required before submit can proceed.')
          return
        }

        const editableValues = [
          baytype.trim(),
          status.trim(),
          parkaidZone.trim(),
          amendReason.trim(),
          notes.trim()
        ]

        const hasEditableValue = editableValues.some((value) => value !== '')

        if (!hasEditableValue) {
          setSubmitError('At least one editable attribute value must be present before submit can proceed.')
          return
        }

        targetFeatureUids = [trimmedFeatureUid]
        successTargetLabel = selectedBay?.label || trimmedFeatureUid

        appendDebugLine(`Selected bay: ${successTargetLabel}`)
        appendDebugLine(`Target feature_uid list: ${targetFeatureUids.join(', ')}`)
        appendDebugLine(`Current record_id: ${currentAttributeRow.recordId}`)

        const latestRowsByFeatureUid = await queryCurrentAttributeRowsByFeatureUid(targetFeatureUids)

        setLiveStatus('Building transaction plan...')

        plan = buildModificationTransactionPlan(
          targetFeatureUids,
          latestRowsByFeatureUid,
          {
            baytype,
            status,
            parkaidZone,
            validFrom,
            amendReason,
            notes
          },
          transactionDateMillis
        )
      }

      appendDebugLine(`transaction_group_id: ${plan.transactionGroupId}`)
      appendDebugLine(`New record_id: ${plan.addFeatures[0].attributes.record_id}`)

      setLiveStatus('Writing AttributeTransactions changes...')

      await submitAttributeTransactionPlan(plan)

      setLiveStatus('Running active-state rebuild...')

      const { jobId, initialJobStatus } = await submitGpRebuild()

      appendDebugLine(`GP job ID: ${jobId}`)
      appendDebugLine(`Initial GP job status: ${initialJobStatus || 'Unknown'}`)

      await pollGpRebuild(jobId, initialJobStatus, (currentJobStatus) => {
        appendDebugLine(`GP job status update: ${currentJobStatus}`)
      })

      setLiveStatus('Refreshing active parking bays...')

      await refreshActiveLayerDisplay()
      setBayRefreshToken(Date.now())

      if (selectionMode === 'batch') {
        await loadBatchSelection(
          targetFeatureUids,
          {
            contextType: batchSelectionContextType,
            contextLabel: batchSelectionContextLabel,
            source: 'post-submit-refresh',
            missingFeatureUidCount: batchMissingFeatureUidCount
          }
        )
      } else {
        setCurrentRowRefreshToken(Date.now())
        await syncMapToFeature(targetFeatureUids[0])
      }

      setSuccessSummary(`Modified parking bay attributes for ${successTargetLabel}. Rebuild completed successfully.`)
      setLiveStatus('Complete.')
    } catch (error: any) {
      console.error('Parking bay attribute modification failed', error)

      setSubmitError(
        error?.message ||
        JSON.stringify(error) ||
        'Failed to complete the parking bay attribute update.'
      )

      setLiveStatus('Submission failed.')
    } finally {
      setIsSubmitting(false)
    }
  }
  const isBatchMode = selectionMode === 'batch'
  const canEditBatchForm = isBatchMode
    ? batchSelectionSummary.includedCount > 0 && !isLoadingBatchSelection
    : selectedFeatureUid !== ''
  const formFieldDisabled = isSubmitting || !canEditBatchForm
  const statusOptionsForRender = isBatchMode
    ? [BATCH_STATUS_DO_NOT_CHANGE, ...STATUS_OPTIONS]
    : STATUS_OPTIONS

  if (!props.useDataSources || props.useDataSources.length < 1) {
    return (
      <div className="widget-parking-bays-attribute-manager jimu-widget p-3">
        <h3>Modify Parking Bay Attributes</h3>
        <p>Select the active parking bays data source in widget settings.</p>
      </div>
    )
  }

  return (
    <div
      className="widget-parking-bays-attribute-manager jimu-widget d-flex flex-column"
      style={{
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        padding: '0.75rem'
      }}
    >
      <DataSourceComponent
        useDataSource={props.useDataSources[0]}
        widgetId={props.id}
        onDataSourceCreated={(ds) => { setActiveBayDs(ds) }}
      >
        {() => null}
      </DataSourceComponent>

      {props.useMapWidgetIds && props.useMapWidgetIds.length > 0 && (
        <JimuMapViewComponent
          useMapWidgetId={props.useMapWidgetIds[0]}
          onActiveViewChange={(view) => {
            setJimuMapView(view)
          }}
        />
      )}

      <div style={{ flex: '0 0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>Modify Parking Bay Attributes</h3>
          <span style={{ fontSize: '0.72rem', color: '#666' }}>{WIDGET_VERSION}</span>
        </div>

        {(isLoadingBays || isLoadingCurrentRow || isLoadingBatchSelection) && (
          <p>Loading live data...</p>
        )}

        {loadError !== '' && (
          <div style={{ border: '1px solid #cc0000', padding: '0.75rem', marginBottom: '1rem' }}>
            <strong>Load error</strong>
            <div>{loadError}</div>
          </div>
        )}

        {(submitError !== '' || successSummary !== '' || statusLine !== '') && (
          <div
            style={{
              border: `1px solid ${submitError !== '' ? '#cc0000' : successSummary !== '' ? '#2c7a2c' : '#999'}`,
              padding: '0.75rem',
              marginBottom: '1rem',
              backgroundColor: submitError !== '' ? '#fff5f5' : successSummary !== '' ? '#f5fff5' : '#fafafa'
            }}
          >
            <strong>{submitError !== '' ? 'Issue' : successSummary !== '' ? 'Update' : 'Status'}</strong>
            {submitError !== '' && (
              <div>{submitError}</div>
            )}
            {successSummary !== '' && (
              <div>{successSummary}</div>
            )}
            {statusLine !== '' && (
              <div style={{ marginTop: submitError !== '' || successSummary !== '' ? '0.35rem' : 0, color: '#555' }}>{statusLine}</div>
            )}
          </div>
        )}

        {showDebug && debugLines.length > 0 && (
          <div style={{ border: '1px solid #666', padding: '0.75rem', marginBottom: '1rem' }}>
            <strong>Debug trace</strong>
            <ul style={{ marginTop: '0.75rem', marginBottom: 0, paddingLeft: '1.25rem' }}>
              {debugLines.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          paddingRight: '0.25rem'
        }}
      >
        <form onSubmit={handleSubmit}>
          <div style={{ border: '1px solid #ddd', padding: '0.75rem', marginBottom: '1rem' }}>
            <strong>Target Bay</strong>

            <div className="mb-3" style={{ marginTop: '0.75rem' }}>
              <label htmlFor={`${props.id}-building`} className="d-block mb-1">{`Parking Lot${REQUIRED_MARKER}`}</label>
              <select
                id={`${props.id}-building`}
                className="w-100"
                value={selectedBuilding}
                onChange={handleBuildingChange}
                disabled={isSubmitting}
              >
                <option value="">Select building...</option>
                {buildings.map((buildingValue) => (
                  <option key={buildingValue} value={buildingValue}>{buildingValue}</option>
                ))}
              </select>
            </div>

            <div className="mb-0">
              <label htmlFor={`${props.id}-feature`} className="d-block mb-1">{`Bay${REQUIRED_MARKER}`}</label>
              <select
                id={`${props.id}-feature`}
                className="w-100"
                value={selectedFeatureUid}
                onChange={handleBayChange}
                disabled={selectedBuilding === '' || isSubmitting}
              >
                <option value="">Select bay...</option>
                {filteredBays.map((bayOption) => (
                  <option key={bayOption.featureUid} value={bayOption.featureUid}>
                    {bayOption.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-3">
              <button
                type="button"
                onClick={selectAllBaysInParkingLot}
                disabled={isSubmitting || isLoadingBays || isLoadingCurrentRow || isLoadingBatchSelection || selectedBuilding === ''}
              >
                Select All Bays
              </button>
            </div>

            <div className="mt-2">
              <label>
                <input
                  type="checkbox"
                  checked={excludeClosedBays}
                  onChange={(event) => { setExcludeClosedBays(event.target.checked) }}
                  disabled={isSubmitting || isLoadingBatchSelection}
                />{' '}
                Exclude Closed Bays
              </label>
            </div>

            <div className="mt-3">
              <button
                type="button"
                onClick={loadSelectedBayFromMap}
                disabled={isSubmitting || isLoadingBays || isLoadingCurrentRow || isLoadingBatchSelection || !activeBayDs}
              >
                Use Selected Bays from Map
              </button>
            </div>
          </div>

          {isBatchMode && (
            <div style={{ border: '1px solid #ddd', padding: '0.75rem', marginBottom: '1rem' }}>
              <strong>Batch Selection</strong>
              <div style={{ marginTop: '0.75rem' }}>
                {batchSelectionContextType === 'map'
                  ? `Selected ${batchSelectionSummary.selectedCount} bay${batchSelectionSummary.selectedCount === 1 ? '' : 's'} from map`
                  : `Selected ${batchSelectionSummary.selectedCount} bay${batchSelectionSummary.selectedCount === 1 ? '' : 's'} in ${batchSelectionContextLabel || '(none)'}`}
              </div>
              <div>
                Included: {batchSelectionSummary.includedCount}
              </div>
              <div>
                Excluded: {batchSelectionSummary.excludedCount}
              </div>
              {batchSelectionContextType === 'map' && (
                <div>
                  Missing feature_uid: {batchMissingFeatureUidCount}
                </div>
              )}
              <div>
                No Current Attribute Row: {batchSelectionSummary.noCurrentAttributeCount}
              </div>
              <div>
                Excluded Closed Bays: {batchSelectionSummary.excludedClosedCount}
              </div>
            </div>
          )}

          {!isBatchMode && selectedBay && (
            <div style={{ border: '1px solid #ddd', padding: '0.75rem', marginBottom: '1rem' }}>
              <strong>Current Active Bay</strong>
              <div style={{ marginTop: '0.75rem' }}>Feature UID: {selectedBay.featureUid}</div>
              <div>Parking Lot: {selectedBay.building}</div>
              <div>Level: {selectedBay.level || '(blank)'}</div>
              <div>Room: {selectedBay.room || '(blank)'}</div>
              <div>Type: {selectedBay.type || '(blank)'}</div>
              <div>Status: {selectedBay.status || '(blank)'}</div>
            </div>
          )}

          {!isBatchMode && currentAttributeRow && (
            <div style={{ border: '1px solid #ddd', padding: '0.75rem', marginBottom: '1rem' }}>
              <strong>Current Attribute Row</strong>
              <ul style={{ marginTop: '0.75rem', marginBottom: 0, paddingLeft: '1.25rem' }}>
                {currentRowSummaryItems.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-3">
            <label htmlFor={`${props.id}-baytype`} className="d-block mb-1">{`Bay Type${isBatchMode ? '' : REQUIRED_MARKER}`}</label>
            <input
              id={`${props.id}-baytype`}
              className="w-100"
              type="text"
              value={baytype}
              onChange={(event) => { setBaytype(event.target.value) }}
              disabled={formFieldDisabled}
              placeholder={isBatchMode ? 'Leave blank to carry forward each bay\'s existing Bay Type' : ''}
            />
          </div>

          <div className="mb-3">
            <label htmlFor={`${props.id}-status`} className="d-block mb-1">{`Status${isBatchMode ? '' : REQUIRED_MARKER}`}</label>
            <select
              id={`${props.id}-status`}
              className="w-100"
              value={status}
              onChange={(event) => { setStatus(event.target.value) }}
              disabled={formFieldDisabled}
            >
              {isBatchMode && (
                <option value="">Mixed values - keep existing</option>
              )}
              {statusOptionsForRender.map((statusOption) => (
                <option key={statusOption} value={statusOption}>
                  {statusOption === BATCH_STATUS_DO_NOT_CHANGE ? 'Do not change' : statusOption}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3">
            <label htmlFor={`${props.id}-parkaid-zone`} className="d-block mb-1">Parkaid Zone</label>
            <input
              id={`${props.id}-parkaid-zone`}
              className="w-100"
              type="text"
              value={parkaidZone}
              onChange={(event) => { setParkaidZone(event.target.value) }}
              disabled={formFieldDisabled}
              placeholder={isBatchMode ? 'Leave blank to carry forward each bay\'s existing Parkaid Zone' : ''}
            />
          </div>

          <div className="mb-3">
            <label htmlFor={`${props.id}-valid-from`} className="d-block mb-1">{`Valid From${REQUIRED_MARKER}`}</label>
            <input
              id={`${props.id}-valid-from`}
              className="w-100"
              type="date"
              value={validFrom}
              onChange={(event) => { setValidFrom(event.target.value) }}
              disabled={formFieldDisabled}
            />
          </div>

          <div className="mb-3">
            <label htmlFor={`${props.id}-amend-reason`} className="d-block mb-1">Amend Reason</label>
            <input
              id={`${props.id}-amend-reason`}
              className="w-100"
              type="text"
              value={amendReason}
              onChange={(event) => { setAmendReason(event.target.value) }}
              disabled={formFieldDisabled}
            />
          </div>

          <div className="mb-3">
            <label htmlFor={`${props.id}-notes`} className="d-block mb-1">Notes</label>
            <textarea
              id={`${props.id}-notes`}
              className="w-100"
              rows={4}
              value={notes}
              onChange={(event) => { setNotes(event.target.value) }}
              disabled={formFieldDisabled || clearNoteFromTransaction}
              placeholder={isBatchMode ? 'Leave blank to carry forward each bay\'s existing Notes' : ''}
            />
          </div>

          {isBatchMode && (
            <div className="mb-3">
              <label>
                <input
                  type="checkbox"
                  checked={clearNoteFromTransaction}
                  onChange={(event) => { setClearNoteFromTransaction(event.target.checked) }}
                  disabled={formFieldDisabled}
                />{' '}
                Clear Note from Transaction
              </label>
            </div>
          )}

          <div className="mb-3">
            <label>
              <input
                type="checkbox"
                checked={showDebug}
                onChange={(event) => { setShowDebug(event.target.checked) }}
                disabled={isSubmitting}
              />{' '}
              Debug
            </label>
          </div>

          <button
            type="submit"
            disabled={
              isSubmitting ||
              validFrom.trim() === '' ||
              (isBatchMode
                ? batchSelectionSummary.includedCount === 0
                : selectedBuilding === '' || selectedFeatureUid === '' || currentAttributeRow === null)
            }
          >
            {isSubmitting ? 'Submitting and waiting for rebuild...' : isBatchMode ? 'Modify attributes for selected bays' : 'Modify attributes'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Widget
