<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

const props = defineProps<{ lang?: 'zh' | 'en' }>()
const isEn = computed(() => props.lang === 'en')

const zhItems = [
  '镜像用固定版本号（如 1.5.35），不用 latest —— 升级前能回滚',
  '四个卷都挂了：data / cache / music / cover_cache（cover_cache 最易漏）',
  '重启策略设为 Always —— 否则点「重启服务」就再也起不来',
  '已改管理员默认密码（出厂 123456）',
  '公网暴露前架了反代 + HTTPS，并设 PROXY_HEADER 拿真实客户端 IP',
  '时区 TZ 设对（日志时间正确，排错直观）',
  '已备份 ./data（至少 config.js + music-accounts.json + users/）',
  '用 /health 验证了服务正常（fnOS 没有 docker logs，全靠它）',
]

const enItems = [
  'Pin a concrete image version (e.g. 1.5.35), not latest — so you can roll back',
  'All four volumes mounted: data / cache / music / cover_cache (cover_cache is easiest to miss)',
  'Restart policy set to Always — otherwise "Restart Service" kills it for good',
  'Changed the default admin password (factory default is 123456)',
  'Put a reverse proxy + HTTPS in front before public exposure, and set PROXY_HEADER for real client IP',
  'Timezone TZ set correctly (log timestamps make sense)',
  'Backed up ./data (at least config.js + music-accounts.json + users/)',
  'Verified health via /health (fnOS has no docker logs, this is your only check)',
]

const items = computed(() => (isEn.value ? enItems : zhItems))
const STORAGE_KEY = computed(() => `lxserver-deploy-checklist-${props.lang || 'zh'}-v1`)

const checked = ref<boolean[]>([])

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY.value) || '[]')
    if (Array.isArray(saved) && saved.length === items.value.length) {
      checked.value = saved
    } else {
      checked.value = items.value.map(() => false)
    }
  } catch {
    checked.value = items.value.map(() => false)
  }
})

watch(
  checked,
  (v) => {
    try {
      localStorage.setItem(STORAGE_KEY.value, JSON.stringify(v))
    } catch {
      /* ignore */
    }
  },
  { deep: true }
)

const checkedCount = computed(() => checked.value.filter(Boolean).length)
const percent = computed(() => Math.round((checkedCount.value / (items.value.length || 1)) * 100))

function reset() {
  checked.value = items.value.map(() => false)
}
</script>

<template>
  <div class="deploy-checklist">
    <div class="dc-header">
      <span class="dc-icon">✅</span>
      <div class="dc-title">
        <h3>{{ isEn ? 'Pre-Deployment Checklist' : '部署前置检查清单' }}</h3>
        <p class="dc-sub">
          {{
            isEn
              ? 'Tick what is done — progress is saved in this browser. Run through it once before you start to dodge 90% of the pitfalls.'
              : '勾选已完成项，进度自动保存在本机浏览器。开干前过一遍，能避开 90% 的坑。'
          }}
        </p>
      </div>
      <div class="dc-progress">
        <span class="dc-count">{{ checkedCount }}/{{ items.length }}</span>
        <div class="dc-bar"><div class="dc-fill" :style="{ width: percent + '%' }"></div></div>
      </div>
    </div>
    <ul class="dc-list">
      <li v-for="(it, i) in items" :key="i" :class="{ done: checked[i] }">
        <label>
          <input type="checkbox" v-model="checked[i]" />
          <span class="dc-text">{{ it }}</span>
        </label>
      </li>
    </ul>
    <button class="dc-reset" type="button" @click="reset">
      {{ isEn ? 'Reset' : '重置' }}
    </button>
  </div>
</template>

<style scoped>
.deploy-checklist {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 18px 20px;
  margin: 16px 0 28px;
  background: var(--vp-c-bg-soft);
}
.dc-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.dc-icon {
  font-size: 26px;
}
.dc-title {
  flex: 1 1 240px;
}
.dc-title h3 {
  margin: 0;
  font-size: 17px;
}
.dc-sub {
  margin: 3px 0 0;
  font-size: 13px;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}
.dc-progress {
  min-width: 150px;
  text-align: right;
}
.dc-count {
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.dc-bar {
  height: 6px;
  border-radius: 4px;
  background: var(--vp-c-divider);
  overflow: hidden;
  margin-top: 4px;
}
.dc-fill {
  height: 100%;
  background: var(--vp-c-brand-1);
  transition: width 0.25s ease;
}
.dc-list {
  list-style: none;
  padding: 0;
  margin: 14px 0 10px;
}
.dc-list li {
  padding: 7px 0;
  border-top: 1px dashed var(--vp-c-divider);
}
.dc-list li:first-child {
  border-top: none;
}
.dc-list label {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.dc-list input {
  margin-top: 3px;
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--vp-c-brand-1);
}
.dc-text {
  font-size: 14px;
  line-height: 1.5;
}
.dc-list li.done .dc-text {
  color: var(--vp-c-text-2);
  text-decoration: line-through;
}
.dc-reset {
  background: transparent;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}
.dc-reset:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
</style>
