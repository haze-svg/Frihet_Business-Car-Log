# Frihet 업무차량 운행관리 (Frihet_Business-Car-Log)

직원 업무용 차량운행일지 · 차량관리/점검일지 · 통합 합계관리 웹앱. FND(사내 NAS 배포)용.

## 구성
- Node.js 20 + Express, PostgreSQL (`DATABASE_URL`), Dockerfile 포함 (포트 3000, `/healthz`)
- 사진(카드 영수증·점검 사진)은 DB에 저장 → 컨테이너 재배포 시에도 유지

## 환경 변수 (FND → 프로젝트 → 고급 설정)
| 변수 | 필수 | 설명 |
|---|---|---|
| `DATABASE_URL` | 필수 | PostgreSQL 연결 문자열 (FND가 DB를 관리하면 자동 주입 여부 확인) |
| `ADMIN_PASSWORD` | 권장 | 최초 관리자(haze@cafefrihet.com) 비밀번호. 미지정 시 임시 비밀번호가 실행 로그에 1회 출력 |
| `INITIAL_PASSWORD` | 선택 | 기본 등록 직원 11명 공통 초기 비밀번호. 미지정 시 관리자 화면에서 개별 '비밀번호 초기화' |
| `KAKAO_REST_KEY` | 선택 | 카카오 장소검색·경로거리·통행료 (설정 화면에서도 입력 가능) |
| `KAKAO_JS_KEY` | 선택 | 경로 지도 표시 |
| `OPINET_KEY` | 선택 | 오피넷 전국 평균 유가 |
| `JWT_SECRET` | 선택 | 미지정 시 DB에 자동 생성 |
| `PGSSL` | 선택 | `true`면 SSL 연결 |

## 계산 기준
- 연료비 = 운행거리 ÷ 공식연비 × 유가(오피넷 전국평균 → 없으면 관리자 수동 유가)
- 운행비 = 연료비 + 통행료 + 주차비
- 공식연비: 관리자가 '공식연비 기준표'에 차종별로 등록 → 차량 등록 시 차종 입력만으로 자동 반영

## 권한
- 로그인: `@cafefrihet.com` 계정만
- 직원: 본인 기록만 조회·작성 / 관리자: 전체 조회·직원 추가·퇴사(접속차단)·설정
- 퇴사 처리 = 접속 차단(기존 기록은 합계에 보존)

## 로컬 실행
```
npm ci
DATABASE_URL=postgres://user:pass@localhost:5432/carlog ADMIN_PASSWORD=... COOKIE_SECURE=false npm start
```
