<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { usePlaceStore, type DuplicateCandidate, type NewPlacePair } from '../stores/placeStore'
import { useSheetStore } from '../stores/sheetStore'
import { useHistoryStore } from '../stores/historyStore'
import type { Certainty, PlacePair, PlaceType } from '../types/placePair'
import { CERTAINTIES, PLACE_TYPES } from '../types/placePair'
import { usePlaceSearch } from '../hooks/usePlaceSearch'
import PairRow from '../components/common/PairRow.vue'
import VacantHint from '../components/common/VacantHint.vue'

const placeStore = usePlaceStore()
const sheetStore = useSheetStore()
const historyStore = useHistoryStore()
const { matches } = usePlaceSearch(placeStore.keyword)

const showCreateForm = ref(false)
const formError = ref('')

const certaintyType: Record<Certainty, 'success' | 'warning' | 'danger'> = {
  确定: 'success',
  存疑: 'warning',
  待考: 'danger',
}

function createEmptyForm(): NewPlacePair {
  return {
    sheetId: sheetStore.sheets[0]?.id ?? '',
    oldName: '',
    newName: '',
    newNameAliases: [],
    aliasList: [],
    placeType: '村镇',
    coordNote: '',
    certainty: '确定',
  }
}

const form = reactive<NewPlacePair>(createEmptyForm())
const aliasInput = ref('')

const showMergeDialog = ref(false)
const duplicateCandidates = ref<DuplicateCandidate[]>([])
const mergeTargetId = ref('')
const absorbRest = ref(false)
const pendingInput = ref<NewPlacePair | null>(null)

const visiblePairs = computed(() =>
  placeStore.filteredPairs.filter((pair) => matches(pair)).sort((left, right) => {
    const sheetCompare = (sheetStore.getSheetById(left.sheetId)?.year ?? 0) - (sheetStore.getSheetById(right.sheetId)?.year ?? 0)
    return sheetCompare || left.oldName.localeCompare(right.oldName, 'zh-CN')
  }),
)

const restDuplicateCount = computed(() =>
  duplicateCandidates.value.filter((candidate) => candidate.pair.id !== mergeTargetId.value).length,
)

function getSheetCode(pair: PlacePair): string {
  return sheetStore.getSheetById(pair.sheetId)?.code ?? '图幅待补'
}

function historyCount(pairId: string): number {
  return historyStore.getForPair(pairId).length
}

function resetForm(): void {
  Object.assign(form, createEmptyForm())
  aliasInput.value = ''
  formError.value = ''
}

function buildInput(): NewPlacePair {
  return {
    ...form,
    oldName: form.oldName.trim(),
    newName: form.newName.trim(),
    coordNote: form.coordNote.trim() || '图上方位待核',
    aliasList: aliasInput.value
      .split(/[、，,]/)
      .map((alias) => alias.trim())
      .filter(Boolean),
  }
}

function closeMergeDialog(): void {
  showMergeDialog.value = false
  duplicateCandidates.value = []
  mergeTargetId.value = ''
  absorbRest.value = false
  pendingInput.value = null
}

async function submitPlace(): Promise<void> {
  if (!form.sheetId || !form.oldName.trim() || !form.newName.trim()) {
    formError.value = '请选择所属图幅，并填写古名与今名。'
    return
  }
  formError.value = ''
  const input = buildInput()
  const duplicates = placeStore.findDuplicates(input)
  if (duplicates.length > 0) {
    pendingInput.value = input
    duplicateCandidates.value = duplicates
    mergeTargetId.value = duplicates[0].pair.id
    absorbRest.value = false
    showMergeDialog.value = true
    return
  }
  await placeStore.addPair(input)
  resetForm()
  showCreateForm.value = false
}

async function confirmMerge(): Promise<void> {
  if (!pendingInput.value || !mergeTargetId.value) {
    return
  }
  const absorbIds = absorbRest.value
    ? duplicateCandidates.value
        .filter((candidate) => candidate.pair.id !== mergeTargetId.value)
        .map((candidate) => candidate.pair.id)
    : []
  const merged = await placeStore.mergeIntoPair(mergeTargetId.value, pendingInput.value, absorbIds)
  closeMergeDialog()
  if (merged) {
    ElMessage.success(
      absorbIds.length > 0
        ? `已并入「${merged.oldName}」，其余 ${absorbIds.length} 条疑似重复一并合并，沿革已随迁。`
        : `已并入「${merged.oldName}」，未另起新条。`,
    )
  }
  resetForm()
  showCreateForm.value = false
}

async function confirmSeparate(): Promise<void> {
  if (!pendingInput.value) {
    return
  }
  await placeStore.addPair(pendingInput.value)
  closeMergeDialog()
  ElMessage.success('已确认另起新条。')
  resetForm()
  showCreateForm.value = false
}

async function initialize(): Promise<void> {
  await Promise.all([sheetStore.init(), placeStore.init(), historyStore.init()])
  if (!form.sheetId) {
    form.sheetId = sheetStore.sheets[0]?.id ?? ''
  }
}

onMounted(() => {
  void initialize()
})
</script>

<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <span class="page-kicker">GAZETTEER CROSS-REFERENCE</span>
        <h1>地名对照台</h1>
        <p>并置古地图旧名与现代地名，收录异写异读、图上方位和核证程度，供地名反向查询与交叉复核。</p>
      </div>
      <el-button type="primary" size="large" data-testid="new-place" @click="showCreateForm = true">
        新建地名对照
      </el-button>
    </div>

    <form v-if="showCreateForm" class="inline-form" data-testid="form-place" @submit.prevent="submitPlace">
      <h2>新建古今地名对照</h2>
      <div class="form-grid">
        <el-form-item label="所属图幅" required>
          <select v-model="form.sheetId" class="native-field" data-testid="field-sheetId">
            <option v-for="sheet in sheetStore.sheets" :key="sheet.id" :value="sheet.id">
              {{ sheet.code }} · {{ sheet.title }}
            </option>
          </select>
        </el-form-item>
        <el-form-item label="图上旧名" required>
          <input v-model="form.oldName" class="native-field" data-testid="field-oldName" />
        </el-form-item>
        <el-form-item label="今地名" required>
          <input v-model="form.newName" class="native-field" data-testid="field-newName" />
        </el-form-item>
        <el-form-item label="地名类型" required>
          <select v-model="form.placeType" class="native-field" data-testid="field-placeType">
            <option v-for="placeType in PLACE_TYPES" :key="placeType" :value="placeType">{{ placeType }}</option>
          </select>
        </el-form-item>
        <el-form-item label="确定度" required>
          <select v-model="form.certainty" class="native-field" data-testid="field-certainty">
            <option v-for="certainty in CERTAINTIES" :key="certainty" :value="certainty">{{ certainty }}</option>
          </select>
        </el-form-item>
        <el-form-item label="异写异读">
          <input v-model="aliasInput" class="native-field" data-testid="field-aliasList" placeholder="多个异写用逗号分隔" />
        </el-form-item>
        <el-form-item label="图上方位" required class="form-grid__wide">
          <textarea v-model="form.coordNote" class="native-field" data-testid="field-coordNote" rows="3"></textarea>
        </el-form-item>
        <div class="form-actions">
          <el-button @click="showCreateForm = false; resetForm()">取消</el-button>
          <el-button type="primary" native-type="submit" data-testid="submit-place">保存对照</el-button>
        </div>
      </div>
      <p v-if="formError" class="text-danger">{{ formError }}</p>
    </form>

    <el-dialog
      v-model="showMergeDialog"
      title="发现疑似重复的地名对照"
      width="660px"
      data-testid="dialog-merge"
      @closed="closeMergeDialog"
    >
      <p class="merge-dialog__tip">
        同一图幅内已有 {{ duplicateCandidates.length }} 条记录与新填内容疑似重复。
        挑一条并进去（异写合并去重、今名不同的一起留着、确定度按更保守档计），也可确认另起新条。
      </p>
      <el-radio-group v-model="mergeTargetId" class="merge-candidate-list">
        <label
          v-for="candidate in duplicateCandidates"
          :key="candidate.pair.id"
          class="merge-candidate"
          :class="{ 'merge-candidate--active': mergeTargetId === candidate.pair.id }"
          :data-testid="`merge-candidate-${candidate.pair.id}`"
        >
          <span class="merge-candidate__head">
            <el-radio :value="candidate.pair.id" class="merge-candidate__radio">
              <strong>{{ candidate.pair.oldName }}</strong>
              <span class="merge-candidate__arrow">→</span>
              <strong class="merge-candidate__new">{{ candidate.pair.newName }}</strong>
              <span v-if="candidate.pair.newNameAliases.length" class="muted">
                （又作：{{ candidate.pair.newNameAliases.join('、') }}）
              </span>
            </el-radio>
          </span>
          <span class="merge-candidate__meta">
            <el-tag size="small" effect="plain">{{ candidate.pair.placeType }}</el-tag>
            <el-tag size="small" :type="certaintyType[candidate.pair.certainty]">{{ candidate.pair.certainty }}</el-tag>
            <span>异写：{{ candidate.pair.aliasList.join('、') || '无' }}</span>
            <span>沿革 {{ historyCount(candidate.pair.id) }} 条</span>
          </span>
          <span class="merge-candidate__reason">{{ candidate.reason }}</span>
        </label>
      </el-radio-group>
      <el-checkbox
        v-if="duplicateCandidates.length > 1"
        v-model="absorbRest"
        class="merge-dialog__absorb"
        data-testid="merge-absorb-rest"
      >
        将其余 {{ restDuplicateCount }} 条疑似重复一并并入所选记录（其沿革随迁到保留记录，时间线仍按年代排列）
      </el-checkbox>
      <template #footer>
        <el-button data-testid="cancel-merge" @click="closeMergeDialog">取消</el-button>
        <el-button data-testid="confirm-separate" @click="confirmSeparate">确认另起</el-button>
        <el-button type="primary" data-testid="confirm-merge" @click="confirmMerge">并入所选</el-button>
      </template>
    </el-dialog>

    <div class="filter-bar">
      <el-input v-model="placeStore.keyword" clearable placeholder="输入古名、今名、异写或图上方位，反向查询" class="filter-bar__grow" />
      <el-select v-model="placeStore.placeTypeFilter" style="width: 130px" aria-label="按地名类型筛选">
        <el-option label="全部类型" value="全部" />
        <el-option v-for="placeType in PLACE_TYPES" :key="placeType" :label="placeType" :value="placeType" />
      </el-select>
      <el-select v-model="placeStore.certaintyFilter" style="width: 130px" aria-label="按确定度筛选">
        <el-option label="全部确定度" value="全部" />
        <el-option v-for="certainty in CERTAINTIES" :key="certainty" :label="certainty" :value="certainty" />
      </el-select>
      <span class="filter-count">当前记录数：<strong data-testid="count-place">{{ visiblePairs.length }}</strong></span>
    </div>

    <div v-if="visiblePairs.length" class="place-list">
      <div v-for="pair in visiblePairs" :key="pair.id" data-testid="row-place">
        <PairRow :pair="pair" :query="placeStore.keyword" :sheet-code="getSheetCode(pair)" />
        <div class="pair-row-actions">
          <router-link :to="`/places/${pair.id}/history`">
            <el-button link type="primary">展开沿革时间线</el-button>
          </router-link>
        </div>
      </div>
    </div>

    <VacantHint
      v-else
      title="没有命中的地名记录"
      description="换用古名、今名、异写或图上方位中的任意关键词，或者新建一条地名对照。"
      action-text="新建地名对照"
      @action="showCreateForm = true"
    />
  </section>
</template>

<style scoped>
.form-grid__wide {
  grid-column: span 2;
}

.pair-row-actions {
  display: flex;
  justify-content: flex-end;
  padding: 5px 12px 0;
}

.merge-dialog__tip {
  margin-bottom: 14px;
  color: var(--muted);
  line-height: 1.7;
}

.merge-candidate-list {
  display: grid;
  width: 100%;
  gap: 10px;
}

.merge-candidate {
  display: block;
  padding: 12px 14px;
  cursor: pointer;
  background: #fbf7ef;
  border: 1px solid #d5c4b0;
  border-radius: 7px;
}

.merge-candidate--active {
  background: #f5ecd9;
  border-color: #a65d48;
  box-shadow: 0 0 0 2px rgba(139, 63, 47, 0.12);
}

.merge-candidate__head {
  display: block;
}

.merge-candidate__radio {
  width: 100%;
  margin-right: 0;
  white-space: normal;
}

.merge-candidate__arrow {
  margin: 0 6px;
  color: #aa8c72;
}

.merge-candidate__new {
  color: var(--moss);
}

.merge-candidate__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
  margin-top: 8px;
  padding-left: 24px;
  color: var(--muted);
  font-size: 12px;
}

.merge-candidate__reason {
  display: block;
  margin-top: 6px;
  padding-left: 24px;
  color: var(--accent-dark);
  font-size: 12px;
}

.merge-dialog__absorb {
  margin-top: 14px;
  white-space: normal;
}

@media (max-width: 680px) {
  .form-grid__wide {
    grid-column: auto;
  }
}
</style>
