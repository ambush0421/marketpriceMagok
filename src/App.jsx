import { useEffect, useState } from "react";

const DASHBOARD_FILE = "20260608-magok-commercial-price-dashboard.html";
const SUMMARY_FILE = "dashboard-summary.json";

function App() {
  const assetBase = import.meta.env.BASE_URL || "./";
  const dashboardUrl = `${assetBase}${DASHBOARD_FILE}`;
  const summaryUrl = `${assetBase}${SUMMARY_FILE}`;
  const heroImage = `url("${assetBase}magok-commercial-hero.png")`;
  const [summary, setSummary] = useState(null);
  const generatedAt = summary?.generatedAt
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(summary.generatedAt))
    : "";
  const searchExamples = summary?.topBuildings?.slice(0, 3) || [];

  useEffect(() => {
    let cancelled = false;

    fetch(summaryUrl, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) setSummary(data);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [summaryUrl]);

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
            한 화면에서 볼 수 있게 정리한 상담·검토용 참고자료입니다.
          </p>
          <div className="reference-note">
            <strong>참고자료</strong>
            <span>법적 효력이나 투자 판단을 보장하지 않으며, 계약 전 원자료와 전문가 확인이 필요합니다.</span>
          </div>
          {summary?.source ? (
            <dl className="source-strip" aria-label="데이터 출처 요약">
              <div>
                <dt>출처</dt>
                <dd>{summary.source.system}</dd>
              </div>
              <div>
                <dt>기간</dt>
                <dd>{summary.source.period} · {summary.source.monthCount}개월</dd>
              </div>
              <div>
                <dt>대시보드 생성</dt>
                <dd>{generatedAt}</dd>
              </div>
            </dl>
          ) : null}
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

      <section className="summary-stage" aria-label="마곡동 실거래 핵심 요약">
        <div className="summary-header">
          <div>
            <span className="section-label">Verified summary</span>
            <h2>원자료와 검증 상태 먼저 보기</h2>
          </div>
          {summary?.source ? (
            <p>
              {summary.source.period}년 · {summary.source.monthCount}개월 · 공식 출처 {summary.source.referenceCount}개
            </p>
          ) : null}
        </div>

        {summary ? (
          <>
            <div className="metric-grid">
              {summary.metricCards.map((card) => (
                <article className="metric-card" key={card.label}>
                  <span>{card.label}</span>
                  <strong>{card.value}</strong>
                  <p>{card.note}</p>
                </article>
              ))}
            </div>

            <div className="detail-grid">
              <section className="detail-panel" aria-label="거래건수 상위 건물">
                <div className="panel-title">
                  <h3>거래건수 상위 건물</h3>
                  <a href="#dashboard-frame">대시보드로 이동</a>
                </div>
                <ol className="building-list">
                  {summary.topBuildings.map((building) => (
                    <li key={`${building.name}-${building.parcel}`}>
                      <div>
                        <strong>{building.name}</strong>
                        <span>{building.parcel} · {building.transactionCount.toLocaleString("ko-KR")}건</span>
                      </div>
                      <em>{building.medianExclusivePyeongPrice}</em>
                    </li>
                  ))}
                </ol>
              </section>

              <section className="detail-panel" aria-label="정제 기준">
                <h3>정제 기준</h3>
                <ul className="quality-list">
                  {summary.qualityNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="search-guide" aria-label="대시보드에서 확인할 대표 건물">
              <h3>대시보드에서 확인할 대표 건물</h3>
              <div>
                {searchExamples.map((building) => (
                  <a href="#dashboard-frame" key={building.name}>
                    {building.name}
                    <span>{building.road || building.parcel}</span>
                  </a>
                ))}
              </div>
            </section>
          </>
        ) : (
          <p className="summary-fallback">요약 파일을 불러오는 중입니다. 전체 대시보드는 아래에서 바로 볼 수 있습니다.</p>
        )}
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
          loading="lazy"
        />
      </section>
    </main>
  );
}

export default App;
