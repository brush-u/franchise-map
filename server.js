process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 정적 파일 서빙 (public 폴더)
app.use(express.static(path.join(__dirname, 'public')));

// 공공데이터 프록시 엔드포인트 (실제 API 연동 버전)
app.get('/api/franchises', async (req, res) => {
    try {
        const serviceKey = process.env.PUBLIC_API_KEY;
        
        if (!serviceKey) {
            console.error('❌ 에러: PUBLIC_API_KEY 환경변수가 설정되지 않았습니다.');
            return res.status(500).json({ error: '서버에 공공데이터 API 인증키가 설정되지 않았습니다.' });
        }

        // 소상공인 상권정보 API 엔드포인트
        const url = 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong';

        const apiResponse = await axios.get(url, {
            params: {
                serviceKey: serviceKey,
                divId: 'ad',          // 행정동 구분 코드 (ad: 행정동)
                key: '11680640',      // 역삼1동 행정동 코드
                numOfRows: '100',
                type: 'json'
            }
        });
        
        res.json(apiResponse.data);

    } catch (error) {
        console.error('공공데이터 연동 상세 에러:', error.response?.data || error.message);
        res.status(500).json({ 
            error: '공공데이터 서버와 통신 중 오류가 발생했습니다.', 
            details: error.response?.data || error.message 
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 백엔드 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
});