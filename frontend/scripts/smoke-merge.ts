/* 冒烟脚本：验证地名对照查重、合并、沿革迁移与计数（node + fake-indexeddb） */
import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaceStore, moreConservativeCertainty } from '../src/stores/placeStore'
import { useHistoryStore } from '../src/stores/historyStore'
import { db } from '../src/utils/db'

setActivePinia(createPinia())
const placeStore = usePlaceStore()
const historyStore = useHistoryStore()

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` → 实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`}`)
}

await placeStore.init()
await historyStore.init()

const SHEET = 'sheet-bp-jia-3' // 已有 2 条：正阳门瓮城、崇文门大街
const beforeCount = placeStore.pairs.length
const beforeSheetCount = placeStore.getPairsForSheet(SHEET).length
check('种子条数（全台）', beforeCount, 12)
check('种子条数（甲-3）', beforeSheetCount, 2)

// 1) 查重：新古名撞已有旧名
let dup = placeStore.findDuplicates({ sheetId: SHEET, oldName: '崇文门大街', aliasList: [] })
check('古名撞旧名 → 命中 1 条', dup.map((d) => d.pair.id), ['place-bp-jia-3-2'])

// 2) 查重：新异写撞别条旧名
dup = placeStore.findDuplicates({ sheetId: SHEET, oldName: '崇文门大街南段', aliasList: ['正阳门瓮城'] })
check('异写撞旧名 → 命中 1 条', dup.map((d) => d.pair.id), ['place-bp-jia-3-1'])

// 3) 查重：不同图幅不命中
dup = placeStore.findDuplicates({ sheetId: 'sheet-tj-dong-2', oldName: '崇文门大街', aliasList: [] })
check('跨图幅不命中', dup.length, 0)

// 4) 确认另起：照常新建
const separate = await placeStore.addPair({
  sheetId: SHEET,
  oldName: '崇文门大街',
  newName: '崇文门内大街',
  newNameAliases: [],
  aliasList: [],
  placeType: '村镇',
  coordNote: '图上方位待核',
  certainty: '确定',
})
check('另起后全台条数 +1', placeStore.pairs.length, beforeCount + 1)

// 5) 新填并入已有：异写并集去重、今名不同一起留、确定度取保守
const merged = await placeStore.mergeIntoPair('place-bp-jia-3-2', {
  sheetId: SHEET,
  oldName: '崇文门大街', // 与目标旧名相同，不进异写
  newName: '崇文门外大街', // 与目标今名不同 → 收进又作
  newNameAliases: [],
  aliasList: ['哈德门大街', '崇文门街'], // 一个重复、一个新增
  placeType: '村镇',
  coordNote: '图幅东侧',
  certainty: '待考', // 目标为确定 → 合并后取待考
})
check('并入后全台条数不变（未另起）', placeStore.pairs.length, beforeCount + 1)
check('异写合并去重', merged?.aliasList, ['哈德门大街', '崇文门里街', '崇文门街'])
check('今名不同一起留着', merged?.newNameAliases, ['崇文门外大街'])
check('确定度取更保守档', merged?.certainty, '待考')
check('目标今名不变', merged?.newName, '崇文门内大街')

// 6) 吸收已有重复记录：沿革随迁、记录删除、条数按合并后算
const histBefore = historyStore.getForPair(separate.id).length
await historyStore.addHistory({
  placePairId: separate.id,
  period: '明永乐十七年（1419）',
  name: '崇文门',
  changeType: '初置',
  sourceRef: '测试出处',
  note: '',
})
const merged2 = await placeStore.mergeIntoPair('place-bp-jia-3-2', {
  sheetId: SHEET,
  oldName: '崇文门大街',
  newName: '崇文门内大街',
  newNameAliases: [],
  aliasList: [],
  placeType: '村镇',
  coordNote: '图上方位待核',
  certainty: '存疑',
}, [separate.id])
check('吸收后全台条数 -1', placeStore.pairs.length, beforeCount)
check('被吸收记录已删除', placeStore.pairs.some((p) => p.id === separate.id), false)
check('沿革随迁到保留记录', historyStore.getForPair('place-bp-jia-3-2').length, 2 + histBefore + 1)
check('被并记录沿革清零', historyStore.getForPair(separate.id).length, 0)
check('时间线仍按年代排', historyStore.getForPair('place-bp-jia-3-2').map((h) => h.period), [
  '明永乐十七年（1419）',
  '明永乐十七年（1419）',
  '1934 年',
])
check('图幅地名数按合并后算', placeStore.getPairsForSheet(SHEET).length, beforeSheetCount)
check('确定度维持更保守档', merged2?.certainty, '待考')

// 7) 保守档函数
check('确定 vs 存疑', moreConservativeCertainty('确定', '存疑'), '存疑')
check('待考 vs 存疑', moreConservativeCertainty('待考', '存疑'), '待考')

// 8) 持久化核对：直接读库
check('库中目标记录已更新', (await db.placePairs.get('place-bp-jia-3-2'))?.certainty, '待考')
check('库中被并记录已删除', await db.placePairs.get(separate.id), undefined)
check('库中沿革已随迁', (await db.histories.where('placePairId').equals('place-bp-jia-3-2').toArray()).length, 3)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
