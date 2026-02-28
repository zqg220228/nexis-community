# AdSense 준비 체크리스트 (Nexis)

## 이미 반영됨
- Privacy page: `/privacy.html`
- Terms page: `/terms.html`
- Contact page: `/contact.html`
- Footer legal links on login/index
- `ads.txt` placeholder 생성 (`/ads.txt`)

## 배포 후 해야 할 것
1. 실제 도메인 연결 (예: `https://nexis.example.com`)
2. `public/sitemap.xml`의 `<loc>`를 실제 절대 URL로 변경
3. `public/ads.txt`에 AdSense publisher 라인 입력
4. Google Search Console 등록 + sitemap 제출
5. AdSense 신청

## 승인 후
- 자동광고(Auto ads) 먼저 ON
- UX 확인 후 수동 슬롯 최적화
