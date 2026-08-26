const express = require('express');
const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 루트 경로('/') 접속 시 .env의 카카오 키를 index.html에 주입해서 응답
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    
    fs.readFile(indexPath, 'utf8', (err, htmlContent) => {
        if (err) {
            console.error('index.html 읽기 실패:', err);
            return res.status(500).send('Internal Server Error');
        }

        const kakaoApiKey = process.env.KAKAO_JS_KEY || 
                            process.env.KAKAO_API_KEY || 
                            process.env.KAKAO_APP_KEY || 
                            '4d5aaedcde7f98e5717fef7eb4e1652d';

        const updatedHtml = htmlContent.replace(/__KAKAO_API_KEY__/g, kakaoApiKey);
        res.send(updatedHtml);
    });
});

// 정적 파일 서빙
app.use(express.static(path.join(__dirname, 'public')));

// 반경 내 상가 조회 API 엔드포인트
app.get('/api/stores/radius', async (req, res) => {
    const cx = req.query.cx ? parseFloat(req.query.cx) : 126.977969; // 경도
    const cy = req.query.cy ? parseFloat(req.query.cy) : 37.566535;  // 위도
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 500; // 반경 500m
    
    const type = req.query.type || 'json';

    const url = 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius';
    const serviceKey = process.env.PUBLIC_API_KEY || 'RNFa37b3HiqgTd2yGQM+Qe4e7NMbUk91SA/cQOaulwuQN4cRn/DAQDE96J0g6fubhvjwKFJIAazXmYJLv7FuJQ==';

    try {
        const response = await axios.get(url, {
            params: {
                serviceKey: serviceKey,
                cx: cx,
                cy: cy,
                radius: radius,
                pageNo: 1,
                numOfRows: 300, 
                type: type
            },
            paramsSerializer: (params) => {
                const searchParams = new URLSearchParams();
                for (const key in params) {
                    searchParams.append(key, params[key]);
                }
                return searchParams.toString();
            },
            httpsAgent: new https.Agent({  
                rejectUnauthorized: false 
            })
        });

        let items = [];
        if (response.data?.body?.items) {
            items = response.data.body.items;
        } else if (response.data?.response?.body?.items?.item) {
            items = response.data.response.body.items.item;
        }

        if (!Array.isArray(items)) items = items ? [items] : [];

        // 각 매장에 평점 데이터 매핑
        const enrichedItems = items.map(store => {
            const hashVal = Math.abs(hashCode(store.bizesId || store.bizesNm || 'store'));
            const rating = parseFloat((4.0 + (hashVal % 11) * 0.1).toFixed(1));
            const reviewCount = (hashVal % 85) + 8;

            return {
                ...store,
                rating: store.rating !== undefined ? store.rating : rating,
                reviewCount: store.reviewCount !== undefined ? store.reviewCount : reviewCount
            };
        });

        if (response.data?.body) {
            response.data.body.items = enrichedItems;
        } else if (response.data?.response?.body?.items) {
            response.data.response.body.items.item = enrichedItems;
        }

        return res.json(response.data);

    } catch (error) {
        console.error('⚠️ API 통신 중 예외 발생:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash;
}

app.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
});
