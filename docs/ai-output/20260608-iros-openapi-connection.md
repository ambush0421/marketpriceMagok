# 등기정보광장 집합건물 실거래가 API 연결 확인

## 확인 결과

- API명: 집합건물 실거래가(등기기준) 정보
- API ID: `0000000305`
- 요청 URL: `https://data.iros.go.kr/openapi/cr/rs/selectCrRsRgsCsOpenApi.rest`
- 인증키: `.env.local`의 `IROS_OPEN_API_KEY`에 저장됨.
- API URL/ID: `.env.local`의 `IROS_APARTMENT_TRADE_API_URL`, `IROS_APARTMENT_TRADE_API_ID`에 저장됨.
- 코드표 원본: `data/raw/iros-code-info-0000000305.xls`
- 샘플 응답 저장: `data/processed/iros-msignature-202503-sample.json`

## 필수 요청 인자

| 인자 | 값 | 설명 |
| --- | --- | --- |
| `id` | `0000000305` | Open API 서비스 ID |
| `reqtype` | `xml` 또는 `json` | 응답 형식 |
| `key` | 환경변수 | 인증키 |
| `search_type_api` | `02` | 월별 검색 |
| `search_start_date_api` | `YYYYMM` | 월별 검색 시작 |
| `search_end_date_api` | `YYYYMM` | 월별 검색 종료 |
| `search_amt_sect` | 코드표 참조 | 금액 구간 |
| `search_area_sect` | 코드표 참조 | 면적 구간 |
| `search_regn1_name_api` | `900` | 서울특별시 |
| `search_regn2_name_api` | `904` | 서울 강서구 |
| `search_buld_name` | 선택 | 건물명 |

## 엠시그니처 검증 호출

```powershell
node scripts\fetch-iros-open-api.cjs --building=엠시그니처
```

2025년 3월, 서울 강서구, 금액 `04`(4억 초과 6억 이하), 면적 `003`(41㎡ ~ 60㎡), 건물명 `엠시그니처` 조건으로 정상 응답을 확인했다.

확인된 응답 요약.

| 지번 | 건물명 | 층 | 원인일자 | 등기일자 | 전용면적 | 거래가 |
| --- | --- | ---: | --- | --- | ---: | ---: |
| 798-14 | 마곡엠시그니처 | 6 | 2025-03-25 | 2025-03-31 | 49.45㎡ | 437,770,000원 |
| 798-14 | 마곡엠시그니처 | 6 | 2025-03-25 | 2025-03-31 | 46㎡ | 407,230,000원 |

## 운영 메모

- 이 API는 등기기준 집합건물 실거래가이며, 화면 안내 기준으로 최근 3년 등기기록 거래가액을 제공한다.
- 일 최대 10회, 요청 최대 1,000건 제한이 있으므로 전수 수집은 금액구간/면적구간/월 단위 호출 계획을 세워야 한다.
- `M시그니처`로 검색하면 결과가 없고, `엠시그니처`로 검색해야 `마곡엠시그니처`가 반환된다.
- 현재 국토교통부 실거래 API의 마스킹 후보 검증에는 등기소 API의 `lotNo`, `buldName`, `buldNoFloor`, `area`, `dealAmt`를 우선 매칭키로 사용한다.
