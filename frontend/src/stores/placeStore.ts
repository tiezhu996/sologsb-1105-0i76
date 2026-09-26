import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Certainty, PlacePair, PlaceType } from '../types/placePair'
import { CERTAINTIES } from '../types/placePair'
import { createId, db, plain } from '../utils/db'
import { useHistoryStore } from './historyStore'

export type NewPlacePair = Omit<PlacePair, 'id' | 'newNameList'> & { newNameList?: string[] }
export type PlacePairInput = Omit<NewPlacePair, 'sheetId'> & { sheetId?: string }

export interface PlaceDuplicateMatch {
  pair: PlacePair
  reasons: string[]
}

export const usePlaceStore = defineStore('place', () => {
  const pairs = ref<PlacePair[]>([])
  const currentPair = ref<PlacePair | null>(null)
  const placeTypeFilter = ref<PlaceType | '全部'>('全部')
  const certaintyFilter = ref<Certainty | '全部'>('全部')
  const keyword = ref('')
  const matchedPairIds = ref<string[]>([])
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const filteredPairs = computed(() =>
    pairs.value.filter((pair) => {
      const matchesType = placeTypeFilter.value === '全部' || pair.placeType === placeTypeFilter.value
      const matchesCertainty =
        certaintyFilter.value === '全部' || pair.certainty === certaintyFilter.value
      return matchesType && matchesCertainty
    }),
  )

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!initialization) {
      initialization = db.placePairs.toArray().then((rows) => {
        pairs.value = rows
        initialized.value = true
      })
    }
    await initialization
  }

  function normalizePlaceName(name: string): string {
    return name.trim().replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
  }

  function uniqueNames(names: string[]): string[] {
    const seen = new Set<string>()
    return names.filter((name) => {
      const key = normalizePlaceName(name)
      if (!key || seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  }

  function getNewNames(pair: Pick<PlacePair, 'newName' | 'newNameList'>): string[] {
    return uniqueNames([pair.newName, ...(pair.newNameList ?? [])])
  }

  function moreConservativeCertainty(left: Certainty, right: Certainty): Certainty {
    return CERTAINTIES[Math.max(CERTAINTIES.indexOf(left), CERTAINTIES.indexOf(right))]
  }

  function duplicateReasons(input: PlacePairInput, existing: PlacePair): string[] {
    const reasons: string[] = []
    const inputOldKey = normalizePlaceName(input.oldName)
    const existingOldKey = normalizePlaceName(existing.oldName)

    if (inputOldKey && inputOldKey === existingOldKey) {
      reasons.push(`古名“${input.oldName.trim()}”相同`)
    }
    if (inputOldKey && existing.aliasList.some((alias) => normalizePlaceName(alias) === inputOldKey)) {
      reasons.push(`新填古名“${input.oldName.trim()}”见于既有异写`)
    }

    const inputAliasMatches = input.aliasList.filter((alias) => {
      const aliasKey = normalizePlaceName(alias)
      return aliasKey === existingOldKey || existing.aliasList.some((item) => normalizePlaceName(item) === aliasKey)
    })
    if (inputAliasMatches.length) {
      reasons.push(`新填异写“${uniqueNames(inputAliasMatches).join('、')}”撞上既有旧名或异写`)
    }

    return reasons
  }

  function findDuplicatePairs(input: PlacePairInput, excludeId = ''): PlaceDuplicateMatch[] {
    if (!input.sheetId) {
      return []
    }

    return pairs.value
      .filter((pair) => pair.sheetId === input.sheetId && pair.id !== excludeId)
      .flatMap((pair) => {
        const reasons = duplicateReasons(input, pair)
        return reasons.length ? [{ pair, reasons }] : []
      })
  }

  function mergePairData(target: PlacePair, source: PlacePairInput): PlacePair {
    const newNameList = uniqueNames([...getNewNames(target), source.newName, ...(source.newNameList ?? [])])
    const canonicalNames = new Set([target.oldName, ...newNameList].map(normalizePlaceName))
    const aliasList = uniqueNames([
      ...target.aliasList,
      ...source.aliasList,
      ...(normalizePlaceName(source.oldName) === normalizePlaceName(target.oldName) ? [] : [source.oldName]),
    ]).filter((alias) => !canonicalNames.has(normalizePlaceName(alias)))

    return {
      ...target,
      newName: newNameList[0] ?? target.newName,
      newNameList,
      aliasList,
      placeType: target.placeType,
      coordNote: [target.coordNote, source.coordNote].filter(Boolean).join('；'),
      certainty: moreConservativeCertainty(target.certainty, source.certainty),
    }
  }

  async function addPair(input: NewPlacePair, duplicateTargetId?: string): Promise<PlacePair> {
    await init()
    const normalizedInput: NewPlacePair = {
      ...input,
      sheetId: input.sheetId,
      oldName: input.oldName.trim(),
      newName: input.newName.trim(),
      newNameList: uniqueNames([input.newName, ...(input.newNameList ?? [])]),
      aliasList: uniqueNames(input.aliasList),
      coordNote: input.coordNote.trim() || '图上方位待核',
    }

    if (duplicateTargetId) {
      const target = pairs.value.find((pair) => pair.id === duplicateTargetId)
      if (target) {
        return mergeWithPair(target.id, normalizedInput)
      }
    }

    const pair: PlacePair = { ...normalizedInput, id: createId('place') }
    await db.placePairs.add(plain(pair))
    pairs.value = [...pairs.value, pair]
    currentPair.value = pair
    return pair
  }

  async function mergeWithPair(targetId: string, source: NewPlacePair | PlacePair): Promise<PlacePair> {
    await init()
    const target = pairs.value.find((pair) => pair.id === targetId)
    const sourcePair = 'id' in source ? pairs.value.find((pair) => pair.id === source.id) : undefined
    if (!target || ('id' in source && !sourcePair)) {
      throw new Error('待合并的地名记录不存在。')
    }

    const existingSource = sourcePair ?? (source as PlacePairInput)
    const sourceId: string = 'id' in source ? source.id : ''
    const merged = mergePairData(target, existingSource)

    await db.transaction('rw', db.placePairs, db.histories, async () => {
      await db.placePairs.put(plain(merged))
      if (sourceId && sourceId !== targetId) {
        await db.histories.where('placePairId').equals(sourceId).modify({ placePairId: targetId })
        await db.placePairs.delete(sourceId)
      }
    })

    if (sourceId && sourceId !== targetId) {
      pairs.value = pairs.value.filter((pair) => pair.id !== sourceId)
      const historyStore = useHistoryStore()
      if (historyStore.initialized) {
        historyStore.histories = historyStore.histories.map((history) =>
          history.placePairId === sourceId ? { ...history, placePairId: targetId } : history,
        )
        if (historyStore.currentPairId === sourceId) {
          historyStore.currentPairId = targetId
        }
      }
    }
    pairs.value = pairs.value.map((pair) => (pair.id === targetId ? merged : pair))
    currentPair.value = merged
    return merged
  }

  async function loadPair(id: string): Promise<void> {
    await init()
    currentPair.value = pairs.value.find((pair) => pair.id === id) ?? (await db.placePairs.get(id)) ?? null
  }

  function getPairsForSheet(sheetId: string): PlacePair[] {
    return pairs.value.filter((pair) => pair.sheetId === sheetId)
  }

  function setMatchedPairIds(ids: string[]): void {
    matchedPairIds.value = [...ids]
  }

  function resetFilters(): void {
    placeTypeFilter.value = '全部'
    certaintyFilter.value = '全部'
    keyword.value = ''
    matchedPairIds.value = []
  }

  return {
    pairs,
    currentPair,
    placeTypeFilter,
    certaintyFilter,
    keyword,
    matchedPairIds,
    filteredPairs,
    initialized,
    init,
    addPair,
    mergeWithPair,
    findDuplicatePairs,
    getNewNames,
    normalizePlaceName,
    moreConservativeCertainty,
    loadPair,
    getPairsForSheet,
    setMatchedPairIds,
    resetFilters,
  }
})
