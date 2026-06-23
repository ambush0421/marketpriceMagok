# 등기소 API 마곡동 전체 건물 수집 계획

## 결론

마곡동 전체 건물은 건물명 필터 없이 수집한다. 등기소 API는 `search_amt_sect`, `search_area_sect`, `search_regn1_name_api`, `search_regn2_name_api`가 필수이므로 전체 조합을 한 번에 받을 수 없다.

따라서 하루 10회 제한에서는 다음 방식이 최적이다.

1. 기간은 3개월 단위로 나눈다.
2. 지역은 서울 `900`, 강서구 `904`로 호출한다.
3. 응답은 강서구 전체가 오므로 `regnAddr`에 `마곡동`이 포함된 행만 남긴다.
4. 금액/면적 구간은 기존 국토부 원자료에서 해당 기간 거래가 가장 많은 조합을 우선 호출한다.
5. 1,000건 초과 또는 기간 제한 오류가 나면 기간을 월 단위로 더 쪼갠다.

## 오늘 확인된 제한

- 최근 3년 전체 기간을 한 번에 호출하면 `APIERROR-0011`이 반환된다.
- 3개월 구간 1회 테스트는 오늘 이미 일별 트래픽 제한에 걸려 `APIERROR-0003`이 반환됐다.
- 오늘 실행 상태는 `data/processed/iros-openapi-last-execute-status.json`에 보존했다.

## 내일 실행 명령

```powershell
node scripts\collect-iros-open-api.cjs --preset=magok-all --split=quarter --combos-per-period=1 --max-calls=10 --execute
```

## 현재 생성된 계획

- 계획 파일: `data/processed/iros-openapi-results.json`
- 호출 수: 10회
- 방식: 최근 분기부터 10개 기간을 선정하고, 각 기간에서 마곡동 국토부 원자료 거래가 가장 많은 금액/면적 조합 1개를 호출한다.

## 엠시그니처 별도 보강

엠시그니처처럼 특정 건물 검증이 필요할 때는 건물명 필터를 넣어 호출 수를 줄인다.

```powershell
node scripts\collect-iros-open-api.cjs --preset=msignature --split=year --execute
```

단, API 명칭은 `M시그니처`가 아니라 `엠시그니처`로 넣어야 `마곡엠시그니처`가 반환된다.
