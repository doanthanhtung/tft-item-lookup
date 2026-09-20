const { createApp, computed, onBeforeUnmount, onMounted, reactive, ref } = Vue;

const FILTER_DEFAULTS = {
  patch: '', rankGroup: 1, gameMode: 'ranked', region: 'all', level: 'all',
  itemCount: 'all', lastRound: 'all', date: 'all', minSample: 100,
};

createApp({
  setup() {
    const catalog = ref([]);
    const selectedUnit = ref('');
    const unitSearch = ref('');
    const filters = reactive({ ...FILTER_DEFAULTS });
    const result = ref(null);
    const loading = ref(false);
    const loadingCatalog = ref(true);
    const error = ref(null);
    const sort = reactive({ key: 'avgPlace', direction: 'asc' });
    const activeTab = ref('trios');
    const appInfo = ref({ cacheTtlMinutes: 15, updateConfigured: false, version: '' });
    const updateStatus = ref({ status: 'disabled', progress: 0 });
    let removeUpdateListener = () => {};
    const theme = ref(localStorage.getItem('tft-theme') || 'dark');
    document.documentElement.dataset.theme = theme.value;

    const selectedName = computed(() => catalog.value.find((unit) => unit.id === selectedUnit.value)?.name || selectedUnit.value);
    const hasPendingChanges = computed(() => {
      if (!result.value) return false;
      const current = JSON.stringify({ unitId: selectedUnit.value, ...filters });
      const previous = JSON.stringify({ unitId: result.value.filters.unitId, ...result.value.filters });
      return current !== previous;
    });
    const updateLabel = computed(() => {
      const status = updateStatus.value.status;
      if (status === 'idle') return 'Tự cập nhật sẵn sàng';
      if (status === 'checking') return 'Đang kiểm tra cập nhật...';
      if (status === 'not-available') return 'Đang dùng bản mới nhất';
      if (status === 'available') return `Có bản ${updateStatus.value.availableVersion || 'mới'}`;
      if (status === 'downloading') return `Đang tải ${Math.round(updateStatus.value.progress || 0)}%`;
      if (status === 'downloaded') return 'Sẵn sàng cài đặt';
      if (status === 'error') return 'Cập nhật không thành công';
      return '';
    });
    const sourceRows = computed(() => result.value?.[activeTab.value] || []);
    const rows = computed(() => [...sourceRows.value]
      .filter((row) => row.games >= Number(filters.minSample || 0))
      .sort((a, b) => {
        const left = Number(a[sort.key] ?? 0);
        const right = Number(b[sort.key] ?? 0);
        return (left - right) * (sort.direction === 'asc' ? 1 : -1);
      }));

    function formatNumber(value, digits = 1) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
      return Number(value).toLocaleString('vi-VN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    function formatGames(value) { return Number(value || 0).toLocaleString('vi-VN'); }
    function formatPercent(value) { return `${formatNumber(value)}%`; }
    function formatDelta(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
      const number = Number(value);
      return `${number > 0 ? '+' : ''}${formatNumber(number, 2)}`;
    }
    function formatDate(value) { return value ? new Date(value).toLocaleString('vi-VN') : 'N/A'; }
    function itemLabel(row) { return row.items.join(' · '); }
    function openSource() { window.tftApi.openSource(); }
    function openReleases() { window.tftApi.openReleases(); }
    function selectUnitFromSearch() {
      const search = unitSearch.value.trim().toLocaleLowerCase('vi-VN');
      const match = catalog.value.find((unit) => unit.name.toLocaleLowerCase('vi-VN') === search || unit.id.toLocaleLowerCase() === search);
      if (match) {
        selectedUnit.value = match.id;
        unitSearch.value = match.name;
      }
    }
    function toggleTheme() {
      theme.value = theme.value === 'dark' ? 'light' : 'dark';
      localStorage.setItem('tft-theme', theme.value);
      document.documentElement.dataset.theme = theme.value;
    }
    function toggleSort(key) {
      if (sort.key === key) sort.direction = sort.direction === 'asc' ? 'desc' : 'asc';
      else { sort.key = key; sort.direction = key === 'avgPlace' ? 'asc' : 'desc'; }
    }
    function sortMark(key) { return sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''; }
    function errorText(value) {
      if (value?.code === 'PATREON_REQUIRED') return 'Advanced Explorer yêu cầu Patreon trong phiên hiện tại. Nguồn công khai của trang chi tiết tướng vẫn có thể dùng để tra cứu.';
      if (value?.code === 'RATE_LIMITED') return 'Nguồn đang giới hạn request (HTTP 429). Hãy thử lại sau ít phút.';
      if (value?.code === 'FORBIDDEN') return 'Nguồn từ chối request (HTTP 403). Hãy mở trang nguồn để kiểm tra quyền truy cập.';
      if (value?.code === 'SCHEMA_CHANGED') return 'Schema nguồn đã thay đổi; ứng dụng đã dừng để tránh hiển thị dữ liệu sai.';
      return value?.message || 'Không thể tải dữ liệu.';
    }
    async function loadCatalog() {
      loadingCatalog.value = true;
      try {
        const response = await window.tftApi.getUnitCatalog();
        catalog.value = response.units;
        if (!selectedUnit.value && catalog.value.length) selectedUnit.value = catalog.value[0].id;
        unitSearch.value = catalog.value.find((unit) => unit.id === selectedUnit.value)?.name || '';
      } catch (value) { error.value = value; }
      finally { loadingCatalog.value = false; }
    }
    async function query() {
      if (!selectedUnit.value || loading.value) return;
      loading.value = true;
      error.value = null;
      try {
        result.value = await window.tftApi.queryExplorer({ unitId: selectedUnit.value, ...filters });
      } catch (value) { error.value = value; result.value = null; }
      finally { loading.value = false; }
    }
    async function checkForUpdates() { updateStatus.value = await window.tftApi.checkForUpdates(); }
    async function downloadUpdate() { updateStatus.value = await window.tftApi.downloadUpdate(); }
    function installUpdate() { window.tftApi.installUpdate(); }
    onMounted(async () => {
      appInfo.value = await window.tftApi.getAppInfo();
      updateStatus.value = await window.tftApi.getUpdateStatus();
      removeUpdateListener = window.tftApi.onUpdateStatus((status) => { updateStatus.value = status; });
      await loadCatalog();
    });
    onBeforeUnmount(() => removeUpdateListener());
    return {
      catalog, selectedUnit, unitSearch, filters, result, loading, loadingCatalog, error, sort, activeTab,
      selectedName, rows, formatNumber, formatGames, formatPercent, formatDelta, formatDate, itemLabel,
      toggleSort, sortMark, errorText, query, appInfo, openSource, selectUnitFromSearch, toggleTheme,
      hasPendingChanges, theme, updateStatus, updateLabel, checkForUpdates, downloadUpdate, installUpdate, openReleases,
    };
  },
  template: `
    <main class="shell" :data-theme="theme" :aria-busy="loading || loadingCatalog">
      <header class="topbar">
        <div><p class="eyebrow">PERSONAL DESKTOP TOOL</p><h1>TFT Item Lookup</h1><p class="subtitle">Tra cứu cách lên đồ dựa trên thống kê trận đấu từ tactics.tools.</p></div>
        <div class="topbar-actions"><span v-if="appInfo.distribution === 'portable'" class="update-note">Portable · cập nhật thủ công</span><span v-else-if="appInfo.updateConfigured" class="update-note" :class="updateStatus.status">{{ updateLabel }}</span><button v-if="appInfo.distribution === 'portable'" class="theme-button" @click="openReleases">Tải bản mới ↗</button><button v-if="appInfo.updateConfigured && ['idle', 'not-available', 'error'].includes(updateStatus.status)" class="theme-button" @click="checkForUpdates">Kiểm tra cập nhật</button><button v-if="appInfo.updateConfigured && updateStatus.status === 'available'" class="theme-button" @click="downloadUpdate">Tải bản mới</button><button v-if="appInfo.updateConfigured && updateStatus.status === 'downloaded'" class="primary-button update-button" @click="installUpdate">Khởi động lại để cập nhật</button><button class="theme-button" :aria-label="theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'" @click="toggleTheme">{{ theme === 'dark' ? 'Sáng' : 'Tối' }}</button><button class="ghost-button" @click="openSource">Mở tactics.tools ↗</button></div>
      </header>
      <section class="panel controls">
        <div class="section-heading"><div><span class="step">01</span><h2>Chọn tướng và bộ lọc</h2></div><span class="muted">Chỉ gửi request khi bấm Tra cứu · cache {{ appInfo.cacheTtlMinutes }} phút</span></div>
        <div class="control-grid">
          <label class="field wide"><span>Tướng</span><input v-model="unitSearch" list="unit-options" placeholder="Tìm theo tên tướng" @change="selectUnitFromSearch" /><datalist id="unit-options"><option v-for="unit in catalog" :key="unit.id" :value="unit.name">{{ unit.id }}</option></datalist><small v-if="selectedUnit">ID ổn định: {{ selectedUnit }}</small></label>
          <label class="field"><span>Patch</span><input v-model="filters.patch" placeholder="Mặc định hiện tại" /></label>
          <label class="field"><span>Rank</span><select v-model.number="filters.rankGroup"><option :value="0">Top</option><option :value="1">Diamond+</option><option :value="2">Platinum+</option><option :value="3">Tất cả</option><option :value="4">Grandmaster+</option></select></label>
          <label class="field"><span>Mode</span><select v-model="filters.gameMode"><option value="ranked">Ranked</option><option value="duo">Double Up</option><option value="hyperroll">Hyper Roll</option></select></label>
          <label class="field"><span>Minimum sample</span><input v-model.number="filters.minSample" type="number" min="0" step="10" /></label>
        </div>
        <details class="advanced-note"><summary>Bộ lọc nâng cao</summary><div class="advanced-grid"><label class="field"><span>Region</span><select v-model="filters.region" disabled><option value="all">Tất cả</option></select></label><label class="field"><span>Level</span><select v-model="filters.level" disabled><option value="all">Tất cả</option></select></label><label class="field"><span>Item count</span><select v-model="filters.itemCount" disabled><option value="all">Tất cả</option></select></label><label class="field"><span>Last round</span><select v-model="filters.lastRound" disabled><option value="all">Tất cả</option></select></label><label class="field"><span>Date</span><input v-model="filters.date" disabled placeholder="Tất cả" /></label></div><p class="muted">Các bộ lọc này thuộc Advanced Explorer và hiện không được nguồn công khai của trang chi tiết áp dụng; chúng được giữ trong query key để sẵn sàng mở rộng.</p></details>
        <div class="actions"><span v-if="loadingCatalog" class="muted">Đang tải danh sách tướng...</span><span v-else-if="catalog.length" class="muted">{{ catalog.length }} tướng khả dụng</span><button class="primary-button" :disabled="!selectedUnit || loading" @click="query">{{ loading ? 'Đang tải...' : 'Tra cứu' }}</button></div>
      </section>
      <div v-if="error" class="alert error"><strong>{{ errorText(error) }}</strong><span>Trạng thái: {{ error.code || 'NETWORK' }}</span></div>
      <template v-if="result">
        <div v-if="hasPendingChanges" class="pending-note">Bộ lọc đã thay đổi. Bấm Tra cứu để cập nhật kết quả.</div>
        <div v-if="result.warning" class="alert warning">{{ result.warning }} <span>Cập nhật: {{ formatDate(result.fetchedAt) }}</span></div>
        <section class="summary-grid"><div class="metric"><span>Games</span><strong>{{ formatGames(result.summary.games) }}</strong></div><div class="metric"><span>Avg. Place</span><strong>{{ formatNumber(result.summary.avgPlace, 2) }}</strong></div><div class="metric"><span>Top 4%</span><strong>{{ formatPercent(result.summary.top4Rate) }}</strong></div><div class="metric"><span>Win%</span><strong>{{ formatPercent(result.summary.winRate) }}</strong></div><div class="metric"><span>Avg. Level</span><strong>{{ formatNumber(result.summary.avgLevel) }}</strong></div></section>
        <section class="panel results"><div class="results-heading"><div><p class="eyebrow">{{ selectedName }}</p><h2>Gợi ý trang bị theo dữ liệu</h2></div><div class="source-state" :class="result.cacheState">{{ result.cacheState === 'stale' ? 'Cache cũ' : result.cacheState === 'live' ? 'Live' : 'Cache mới' }} · {{ formatDate(result.fetchedAt) }}</div></div>
          <nav class="tabs"><button :class="{active: activeTab === 'trios'}" @click="activeTab='trios'">Bộ 3 ({{ result.trios.length }})</button><button :class="{active: activeTab === 'pairs'}" @click="activeTab='pairs'">Bộ 2 ({{ result.pairs.length }})</button><button :class="{active: activeTab === 'items'}" @click="activeTab='items'">Trang bị đơn ({{ result.items.length }})</button></nav>
          <div v-if="!rows.length" class="empty">Không có kết quả đạt minimum sample hiện tại.</div>
          <div v-else class="table-wrap"><table><caption class="sr-only">Thống kê trang bị của {{ selectedName }}</caption><thead><tr><th scope="col">Trang bị</th><th scope="col"><button @click="toggleSort('games')" :aria-label="'Sắp xếp theo Games'">Games{{ sortMark('games') }}</button></th><th scope="col"><button @click="toggleSort('playRate')" :aria-label="'Sắp xếp theo Play Rate'">Play Rate{{ sortMark('playRate') }}</button></th><th scope="col"><button @click="toggleSort('avgPlace')" :aria-label="'Sắp xếp theo Avg. Place'">Avg. Place{{ sortMark('avgPlace') }}</button></th><th scope="col"><button @click="toggleSort('top4Rate')" :aria-label="'Sắp xếp theo Top 4'">Top 4%{{ sortMark('top4Rate') }}</button></th><th scope="col"><button @click="toggleSort('winRate')" :aria-label="'Sắp xếp theo Win'">Win%{{ sortMark('winRate') }}</button></th><th scope="col"><button @click="toggleSort('delta')" :aria-label="'Sắp xếp theo Delta'">Delta{{ sortMark('delta') }}</button></th></tr></thead><tbody><tr v-for="row in rows" :key="row.itemIds.join('|')"><td><span class="item-chip" v-for="item in row.items" :key="item">{{ item }}</span></td><td>{{ formatGames(row.games) }}</td><td>{{ formatPercent(row.playRate) }}</td><td>{{ formatNumber(row.avgPlace, 2) }}</td><td>{{ formatPercent(row.top4Rate) }}</td><td>{{ formatPercent(row.winRate) }}</td><td :class="row.delta < 0 ? 'good' : row.delta > 0 ? 'bad' : ''">{{ formatDelta(row.delta) }}</td></tr></tbody></table></div>
          <footer class="result-footer"><span>Delta là adjusted delta từ nguồn; số liệu chỉ mang tính tham khảo.</span><a :href="result.sourceUrl" target="_blank">Xem nguồn ↗</a></footer>
        </section>
      </template>
      <section v-else-if="loading" class="empty-panel loading-panel"><div class="skeleton-line wide-skeleton"></div><div class="skeleton-line short-skeleton"></div><div class="skeleton-table"><i v-for="n in 5" :key="n"></i></div><p>Đang lấy dữ liệu từ nguồn công khai...</p></section>
      <section v-else-if="!error" class="empty-panel"><div class="empty-icon">✦</div><h2>Sẵn sàng tra cứu</h2><p>Chọn tướng, tinh chỉnh rank hoặc mode, rồi bấm Tra cứu để xem bộ item phổ biến.</p></section>
      <footer class="disclaimer">Nguồn: tactics.tools · Không đăng nhập, không vượt CAPTCHA, tối thiểu 1 giây giữa các request · Dữ liệu nguồn được xem là không đáng tin cậy.</footer>
    </main>
  `,
}).mount('#app');
