process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 정적 파일 서빙 (public 폴더)
app.use(express.static(path.join(__dirname, 'public')));

// 가상 데이터 테스트용 프록시 엔드포인트
app.get('/api/franchises', async (req, res) => {
    try {
        // 공공데이터 연동 전 정상 통신 테스트를 위한 가상 상점 데이터
        const mockData = {
            body: {
                items: [
                    { bizesNm: '스타벅스 역삼점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 테헤란로 152', lat: '37.500655', lon: '127.036431' },
                    { bizesNm: '투썸플레이스 역삼역점', indsSclsNm: '커피숍/카페', rdnmAdr: '서울특별시 강남구 테헤란로 145', lat: '37.500120', lon: '127.035500' },
                    { bizesNm: '파리바게뜨 역삼중앙점', indsSclsNm: '제과/제빵', rdnmAdr: '서울특별시 강남구 역삼로 100', lat: '37.498000', lon: '127.038000' }
                ]
            }
        };

        res.json(mockData);

    } catch (error) {
        console.error('테스트 데이터 응답 오류:', error);
        res.status(500).json({ error: '서버 내부 오류 발생' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 백엔드 서버가 포트 ${PORT}에서 정상적으로 실행 중입니다.`);
});
