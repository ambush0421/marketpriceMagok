const DASHBOARD_FILE = "20260608-magok-commercial-price-dashboard.html";

function App() {
  const assetBase = import.meta.env.BASE_URL || "/";
  const dashboardUrl = `${assetBase}${DASHBOARD_FILE}`;
  const heroImage = `url("${assetBase}magok-commercial-hero.png")`;

  return (
    <main className="app-shell">
      <section
        className="app-hero"
        style={{ "--hero-image": heroImage }}
        aria-label="마곡동 실거래 대시보드 소개"
      >
        <div className="hero-copy">
          <span className="eyebrow">MAGOK COMMERCIAL PRICE GUIDE</span>
          <h1>마곡동 상가·업무시설 실거래를 건물별로 확인하세요</h1>
          <p>
            최근 10년 매매 실거래, 건물명 매칭, 전용·계약 평당가, 월별 변동 그래프를
            한 화면에서 볼 수 있게 정리했습니다.
          </p>
        </div>
        <div className="hero-actions">
          <a className="primary-action" href={dashboardUrl} target="_blank" rel="noreferrer">
            대시보드 새 창 열기
          </a>
          <a className="secondary-action" href="#dashboard-frame">
            바로 보기
          </a>
        </div>
      </section>

      <section className="dashboard-stage" aria-label="마곡동 실거래 대시보드">
        <div className="stage-header">
          <div>
            <span className="section-label">Live dashboard</span>
            <h2>건물 검색부터 가격 변동까지</h2>
          </div>
          <a href={dashboardUrl} target="_blank" rel="noreferrer">
            전체 화면
          </a>
        </div>
        <iframe
          id="dashboard-frame"
          title="마곡동 상업용 부동산 실거래 대시보드"
          src={dashboardUrl}
        />
      </section>
    </main>
  );
}

export default App;
