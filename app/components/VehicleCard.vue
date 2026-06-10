<script setup lang="ts">
import type { VehicleRecord } from '#shared/types/vehicle'

const props = defineProps<{ vehicle: VehicleRecord }>()
const emit = defineEmits<{ sent: [id: string] }>()

const sending = ref(false)
const error = ref<string | null>(null)

const fipePercent = computed(() => {
  const { price, fipe } = props.vehicle
  if (price == null || fipe == null || fipe <= 0) return null
  return Math.round((price / fipe) * 100)
})

// verde ≤55% | azul ≤75% | vermelho >75%
const fipeTier = computed(() => {
  const p = fipePercent.value
  if (p == null) return null
  if (p <= 55) return 'green'
  if (p <= 75) return 'blue'
  return 'red'
})

const priceFormatted = computed(() =>
  props.vehicle.price != null
    ? `R$ ${props.vehicle.price.toLocaleString('pt-BR')}`
    : '—',
)

const fipeFormatted = computed(() =>
  props.vehicle.fipe != null
    ? `R$ ${props.vehicle.fipe.toLocaleString('pt-BR')}`
    : null,
)

const auctionDateFormatted = computed(() => {
  const d = props.vehicle.auctionDate
  if (!d) return null
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
})

async function send() {
  if (sending.value) return
  sending.value = true
  error.value = null
  try {
    await $fetch(`/api/vehicles/${props.vehicle._id}/send`, { method: 'POST' })
    emit('sent', props.vehicle._id!)
  }
  catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    error.value = msg.replace(/^.*?:\s*/, '').slice(0, 80)
  }
  finally {
    sending.value = false
  }
}

const SOURCE_LABELS: Record<string, string> = {
  'vs-veiculos': 'VS Veículos',
  'sodre': 'Sodre',
  'copart': 'Copart',
  'favareto': 'Favareto',
  'megaleiloes': 'MegaLeilões',
  'lucinei': 'Lucinei',
  'vardana': 'Vardana',
  'claudio-kuss': 'C. Kuss',
  'superbid': 'Superbid',
  'leiloesjudiciais': 'Judiciais',
  'vipleiloes': 'VIP',
  'mgl': 'MGL',
  'facebook-marketplace': 'Facebook',
}
</script>

<template>
  <div class="card" :class="{ favorite: vehicle.status === 'favorite' }">
    <!-- Imagem -->
    <a :href="vehicle.url" target="_blank" class="card-img-wrap">
      <img
        v-if="vehicle.imageUrls?.[0]"
        :src="vehicle.imageUrls[0]"
        :alt="`${vehicle.brand} ${vehicle.model}`"
        class="card-img"
        loading="lazy"
      />
      <div v-else class="card-img card-img-placeholder">sem foto</div>

      <!-- Badge de FIPE% sobre a imagem -->
      <div v-if="fipePercent != null" class="fipe-badge" :class="fipeTier">
        {{ fipePercent }}%
      </div>
      
    <!-- Botão WhatsApp flutuante -->
    <button
      v-if="vehicle.status === 'scraped'"
      class="btn-wa"
      :class="{ loading: sending }"
      :disabled="sending"
      :title="sending ? 'Enviando…' : 'Enviar via WhatsApp'"
      @click.prevent="send"
    >
      <span v-if="sending" class="wa-spinner" />
      <svg v-else viewBox="0 0 24 24" class="wa-icon" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
      </svg>
    </button>
    </a>

    <!-- Corpo -->
    <div class="card-body">
      <!-- Origem + dano -->
      <div class="card-tags">
        <span class="source-tag">{{ SOURCE_LABELS[vehicle.source] ?? vehicle.source }}</span>
        <span v-if="vehicle.damage" class="damage-tag">{{ vehicle.damage }}</span>
        <span v-if="vehicle.status === 'favorite'" class="favorite-tag">★ Enviado</span>
      </div>

      <!-- Título -->
      <a :href="vehicle.url" target="_blank" class="card-title">
        {{ vehicle.brand }} {{ vehicle.model }}
        <span v-if="vehicle.year" class="year-tag">{{ vehicle.year }}</span>
      </a>

      <!-- Preços -->
      <div class="prices">
        <div class="price-row">
          <span class="price">{{ priceFormatted }}</span>
          <span v-if="fipePercent != null" class="fipe-pct-inline" :class="fipeTier">
            {{ fipePercent }}% da FIPE
          </span>
        </div>
        <div v-if="fipeFormatted" class="fipe-row">
          <span class="fipe-label">FIPE</span>
          <span class="fipe-value">{{ fipeFormatted }}</span>
        </div>
      </div>

      <!-- Meta -->
      <div class="card-meta">
        <span v-if="vehicle.yard">📍 {{ vehicle.yard }}</span>
        <span v-if="vehicle.lot">Lote {{ vehicle.lot }}</span>
        <span v-if="vehicle.km">{{ vehicle.km }} km</span>
        <span v-if="auctionDateFormatted">🗓 {{ auctionDateFormatted }}</span>
      </div>

      <!-- Erro de envio -->
      <div v-if="error" class="send-error">⚠ {{ error }}</div>
    </div>

  </div>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: #1a1d27;
  border: 1px solid #2d3148;
  border-radius: 10px;
  overflow: visible;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.card:hover { border-color: #4a5080; }
.card.favorite { border-color: #4f46e5; box-shadow: 0 0 0 1px #4f46e520; }

/* Imagem */
.card-img-wrap {
  display: block;
  position: relative;
  border-radius: 10px 10px 0 0;
  overflow: hidden;
  flex-shrink: 0;
}
.card-img {
  width: 100%; height: 150px;
  object-fit: cover; display: block;
  background: #0f1117;
}
.card-img-placeholder {
  height: 150px;
  display: flex; align-items: center; justify-content: center;
  color: #4a5080; font-size: 12px;
  background: #12141e;
}

/* FIPE % badge na imagem */
.fipe-badge {
  position: absolute;
  top: 8px; right: 8px;
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 12px; font-weight: 800;
  letter-spacing: 0.02em;
  backdrop-filter: blur(4px);
}
.fipe-badge.green { background: rgba(20, 48, 26, 0.85); color: #4ade80; }
.fipe-badge.blue  { background: rgba(12, 30, 60, 0.85); color: #60a5fa; }
.fipe-badge.red   { background: rgba(45, 16, 16, 0.85); color: #f87171; }

/* Corpo */
.card-body {
  padding: 11px 12px 14px;
  display: flex; flex-direction: column; gap: 5px;
  flex: 1;
}

.card-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.source-tag {
  font-size: 10.5px; padding: 2px 7px;
  border-radius: 4px; background: #252840; color: #a78bfa; font-weight: 500;
}
.damage-tag {
  font-size: 10.5px; padding: 2px 7px;
  border-radius: 4px; background: #2d1a1a; color: #f87171; font-weight: 500;
}
.favorite-tag {
  font-size: 10.5px; padding: 2px 7px;
  border-radius: 4px; background: #1e2038; color: #818cf8; font-weight: 600;
}

.card-title {
  font-size: 13px; font-weight: 600; color: #e2e8f0; line-height: 1.3;
  display: block;
}
.card-title:hover { color: #a78bfa; }
.year-tag { color: #4a5080; font-weight: 400; margin-left: 2px; }

/* Preços */
.prices { display: flex; flex-direction: column; gap: 2px; }

.price-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.price { font-size: 16px; font-weight: 800; color: #f8fafc; }

.fipe-pct-inline {
  font-size: 11.5px; font-weight: 700;
  padding: 2px 6px; border-radius: 4px;
}
.fipe-pct-inline.green { background: #14301a; color: #4ade80; }
.fipe-pct-inline.blue  { background: #0c1e3c; color: #60a5fa; }
.fipe-pct-inline.red   { background: #2d1010; color: #f87171; }

.fipe-row { display: flex; align-items: center; gap: 5px; }
.fipe-label { font-size: 10px; font-weight: 600; color: #4a5080; text-transform: uppercase; letter-spacing: 0.05em; }
.fipe-value { font-size: 11.5px; color: #64748b; }

/* Meta */
.card-meta {
  display: flex; flex-wrap: wrap; gap: 5px;
  font-size: 10.5px; color: #4a5080; margin-top: 2px;
}

.send-error { font-size: 10.5px; color: #f87171; }

/* Botão WhatsApp flutuante */
.btn-wa {
  position: absolute;
  bottom: 12px; right: 12px;
  width: 36px; height: 36px;
  background: #25d366;
  border: none; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  box-shadow: 0 3px 10px rgba(37, 211, 102, 0.45);
  transition: background 0.15s, transform 0.15s, box-shadow 0.15s;
  color: #fff;
  z-index: 1;
}
.btn-wa:hover:not(:disabled) {
  background: #20c55a;
  transform: scale(1.08);
  box-shadow: 0 4px 14px rgba(37, 211, 102, 0.6);
}
.btn-wa:disabled { opacity: 0.6; cursor: default; }

.wa-icon { width: 18px; height: 18px; }

.wa-spinner {
  width: 16px; height: 16px;
  border: 2px solid rgba(255,255,255,0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
