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

import { buildModificationTransactionPlan, pollGpRebuild, queryCurrentAttributeRowsByFeatureUid, submitAttributeTransactionPlan, submitGpRebuild, type AttributeTransactionRow } from './lib/transaction-helpers'
import { escapeSqlValue, firstValue, formatEpochAsDateInput, getRecordAttributes, getTodayDateInputValue, parseDateInputToEpoch } from './lib/field-helpers'

const { useEffect, useMemo, useRef, useState } = React

const STATUS_OPTIONS = [
  'Open',
  'Closed (Temporary)',
  'Closed (Permanent)'
]

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

const WIDGET_VERSION = 'v2026.05.13-1.2'

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

const Widget = (props: AllWidgetProps<any>) => {
  const [activeBayDs, setActiveBayDs] = useState<DataSource | null>(null)
  const [jimuMapView, setJimuMapView] = useState<JimuMapView | null>(null)

  const [activeBays, setActiveBays] = useState<ActiveBayOption[]>([])
  const [selectedBuilding, setSelectedBuilding] = useState('')
  const [selectedFeatureUid, setSelectedFeatureUid] = useState('')
  const [currentAttributeRow, setCurrentAttributeRow] = useState<AttributeTransactionRow | null>(null)

  const [baytype, setBaytype] = useState('')
  const [status, setStatus] = useState('')
  const [parkaidZone, setParkaidZone] = useState('')
  const [validFrom, setValidFrom] = useState(() => {
    return getTodayDateInputValue()
  })
  const [amendReason, setAmendReason] = useState('')
  const [notes, setNotes] = useState('')
  const [showDebug, setShowDebug] = useState(false)

  const [isLoadingBays, setIsLoadingBays] = useState(false)
  const [isLoadingCurrentRow, setIsLoadingCurrentRow] = useState(false)
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
  }

  const applyCurrentRowToForm = (row: AttributeTransactionRow) => {
    setCurrentAttributeRow(row)
    setBaytype(row.baytype || '')
    setStatus(row.status || '')
    setParkaidZone(row.parkaidZone || '')
    setValidFrom(getTodayDateInputValue())
    setAmendReason('')
    setNotes(row.notes || '')
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
    setSelectedBuilding(event.target.value)
    setSelectedFeatureUid('')
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

    if (selectedRecords.length > 1) {
      clearMessages()
      setLiveStatus('Multiple selected bays are not supported yet. v1 only supports one selected bay.')
      return
    }

    const selectedRecordAttributes = getRecordAttributes(selectedRecords[0])
    const selectedFeatureUidFromMap = firstValue(selectedRecordAttributes, ['feature_uid', 'FEATURE_UID'])
    const selectedBuildingFromMap = firstValue(selectedRecordAttributes, ['building', 'BUILDING'])
    const matchingLoadedBay = activeBays.find((item) => item.featureUid === selectedFeatureUidFromMap)

    const resolvedFeatureUid = matchingLoadedBay?.featureUid || selectedFeatureUidFromMap
    const resolvedBuilding = matchingLoadedBay?.building || selectedBuildingFromMap

    if (resolvedFeatureUid === '') {
      clearMessages()
      setLiveStatus('The selected map feature does not provide feature_uid.')
      return
    }

    if (resolvedBuilding === '') {
      clearMessages()
      setLiveStatus(`The selected map feature for feature_uid ${resolvedFeatureUid} does not provide the Parking Lot value needed by the dropdown path.`)
      return
    }

    activateTargetBay(resolvedFeatureUid, resolvedBuilding)
    setLiveStatus(`Selected bay loaded from map: ${resolvedFeatureUid}`)
    appendDebugLine(`Map-selected bay loaded. feature_uid=${resolvedFeatureUid}`)
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isSubmitting) {
      return
    }

    clearMessages()
    setLoadError('')

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

    if (validFrom.trim() === '') {
      setSubmitError('valid_from is required before submit can proceed.')
      return
    }

    if (parseDateInputToEpoch(validFrom) === null) {
      setSubmitError('valid_from is invalid.')
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

    const transactionDateMillis = Date.now()
    const targetFeatureUids = [trimmedFeatureUid]

    setIsSubmitting(true)
    setLiveStatus('Preparing attribute transaction...')

    try {
      appendDebugLine(`Selected bay: ${selectedBay?.label || trimmedFeatureUid}`)
      appendDebugLine(`Target feature_uid list: ${targetFeatureUids.join(', ')}`)
      appendDebugLine(`Current record_id: ${currentAttributeRow.recordId}`)

      const latestRowsByFeatureUid = await queryCurrentAttributeRowsByFeatureUid(targetFeatureUids)

      setLiveStatus('Building transaction plan...')

      const plan = buildModificationTransactionPlan(
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
      setCurrentRowRefreshToken(Date.now())
      await syncMapToFeature(trimmedFeatureUid)

      setSuccessSummary(`Modified parking bay attributes for ${selectedBay?.label || trimmedFeatureUid}. Rebuild completed successfully.`)
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

        {(isLoadingBays || isLoadingCurrentRow) && (
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
                onClick={loadSelectedBayFromMap}
                disabled={isSubmitting || isLoadingBays || isLoadingCurrentRow || !activeBayDs}
              >
                Use Selected Bay From Map
              </button>
            </div>
          </div>

          {selectedBay && (
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

          {currentAttributeRow && (
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
            <label htmlFor={`${props.id}-baytype`} className="d-block mb-1">{`Bay Type${REQUIRED_MARKER}`}</label>
            <input
              id={`${props.id}-baytype`}
              className="w-100"
              type="text"
              value={baytype}
              onChange={(event) => { setBaytype(event.target.value) }}
              disabled={selectedFeatureUid === '' || isSubmitting}
            />
          </div>

          <div className="mb-3">
            <label htmlFor={`${props.id}-status`} className="d-block mb-1">{`Status${REQUIRED_MARKER}`}</label>
            <select
              id={`${props.id}-status`}
              className="w-100"
              value={status}
              onChange={(event) => { setStatus(event.target.value) }}
              disabled={selectedFeatureUid === '' || isSubmitting}
            >
              <option value="">Select status...</option>
              {STATUS_OPTIONS.map((statusOption) => (
                <option key={statusOption} value={statusOption}>{statusOption}</option>
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
              disabled={selectedFeatureUid === '' || isSubmitting}
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
              disabled={selectedFeatureUid === '' || isSubmitting}
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
              disabled={selectedFeatureUid === '' || isSubmitting}
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
              disabled={selectedFeatureUid === '' || isSubmitting}
            />
          </div>

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
              selectedBuilding === '' ||
              selectedFeatureUid === '' ||
              baytype.trim() === '' ||
              status.trim() === '' ||
              validFrom.trim() === '' ||
              currentAttributeRow === null
            }
          >
            {isSubmitting ? 'Submitting and waiting for rebuild...' : 'Modify attributes'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Widget
