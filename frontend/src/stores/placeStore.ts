import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Certainty, PlacePair, PlaceType } from '../types/placePair'
import { CERTAINTIES } from '../types/placePair'
import { createId, db, plain } from '../utils/db'
import { useHistoryStore } from './historyStore'

export type NewPlacePair = Omit<PlacePair, 'id'>

export interface DuplicateCandidate {
  pair: PlacePair
  reason: string
}

/** 旧库记录可能缺少后加字段，读入时统一补齐。 */
function normalizePair(row: PlacePair): PlacePair {
  return {
    ...row,
    aliasList: row.aliasList ?? [],
    newNameAliases: row.newNameAliases ?? [],
  }
}

/** 确定度按更保守的那档算：确定 < 存疑 < 待考。 */
export function moreConservativeCertainty(left: Certainty, right: Certainty): Certainty {
  return CERTAINTIES[Math.max(CERTAINTIES.indexOf(left), CERTAINTIES.indexOf(right))]
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
        pairs.value = rows.map(normalizePair)
        initialized.value = true
      })
    }
    await initialization
  }

  async function addPair(input: NewPlacePair): Promise<PlacePair> {
    await init()
    const pair: PlacePair = normalizePair({ ...input, id: createId('place') })
    await db.placePairs.add(plain(pair))
    pairs.value = [...pairs.value, pair]
    currentPair.value = pair
    return pair
  }

  /**
   * 同一图幅内查疑似重复：新填古名撞上已有旧名，
   * 或新填异写撞上别条旧名。
   */
  function findDuplicates(input: Pick<NewPlacePair, 'sheetId' | 'oldName' | 'aliasList'>): DuplicateCandidate[] {
    const oldName = input.oldName.trim()
    const aliases = new Set(input.aliasList.map((alias) => alias.trim()).filter(Boolean))
    const candidates: DuplicateCandidate[] = []
    for (const pair of pairs.value) {
      if (pair.sheetId !== input.sheetId) {
        continue
      }
      if (oldName && pair.oldName === oldName) {
        candidates.push({ pair, reason: '新填古名与该条旧名相同' })
      } else if (aliases.has(pair.oldName)) {
        candidates.push({ pair, reason: `新填异写「${pair.oldName}」撞上该条旧名` })
      }
    }
    return candidates
  }

  /**
   * 把新填内容并入目标记录，可同时吸收其余疑似重复记录：
   * 两边异写合成一份去重（来源古名一并收编），今名不同的一起留着，
   * 确定度按更保守的那档算；被吸收记录的沿革挪到目标记录上。
   */
  async function mergeIntoPair(
    targetId: string,
    incoming: NewPlacePair,
    absorbIds: string[] = [],
  ): Promise<PlacePair | null> {
    await init()
    const target = pairs.value.find((pair) => pair.id === targetId)
    if (!target) {
      return null
    }
    const absorbed = pairs.value.filter((pair) => absorbIds.includes(pair.id) && pair.id !== targetId)

    const aliasSet = new Set(target.aliasList)
    const collectAlias = (name: string): void => {
      const trimmed = name.trim()
      if (trimmed && trimmed !== target.oldName) {
        aliasSet.add(trimmed)
      }
    }
    incoming.aliasList.forEach(collectAlias)
    collectAlias(incoming.oldName)
    for (const source of absorbed) {
      source.aliasList.forEach(collectAlias)
      collectAlias(source.oldName)
    }

    const newNameSet = new Set(target.newNameAliases)
    const collectNewName = (name: string): void => {
      const trimmed = name.trim()
      if (trimmed && trimmed !== target.newName) {
        newNameSet.add(trimmed)
      }
    }
    collectNewName(incoming.newName)
    for (const source of absorbed) {
      collectNewName(source.newName)
      source.newNameAliases.forEach(collectNewName)
    }

    let certainty = moreConservativeCertainty(target.certainty, incoming.certainty)
    for (const source of absorbed) {
      certainty = moreConservativeCertainty(certainty, source.certainty)
    }

    const merged: PlacePair = {
      ...target,
      aliasList: [...aliasSet],
      newNameAliases: [...newNameSet],
      certainty,
    }
    await db.placePairs.put(plain(merged))

    if (absorbed.length > 0) {
      const absorbedIds = absorbed.map((source) => source.id)
      await useHistoryStore().reassignHistories(absorbedIds, targetId)
      await db.placePairs.bulkDelete(absorbedIds)
      const absorbedIdSet = new Set(absorbedIds)
      pairs.value = pairs.value.filter((pair) => !absorbedIdSet.has(pair.id))
    }

    pairs.value = pairs.value.map((pair) => (pair.id === targetId ? merged : pair))
    currentPair.value = merged
    return merged
  }

  async function loadPair(id: string): Promise<void> {
    await init()
    const found = pairs.value.find((pair) => pair.id === id) ?? (await db.placePairs.get(id))
    currentPair.value = found ? normalizePair(found) : null
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
    findDuplicates,
    mergeIntoPair,
    loadPair,
    getPairsForSheet,
    setMatchedPairIds,
    resetFilters,
  }
})
