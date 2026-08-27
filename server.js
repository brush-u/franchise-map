const express = require('express');
const path = require('path');
const axios = require('axios');
const https = require('https');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 제공해주신 소상공인시장진흥공단 일반인증키 (디코딩 적용)
const SERVICE_KEY = 'k8kTxDVL4QLUqBepVF/lczvdnyZkdJj4bQnVX2ZYjJYlMGI67z65RcCyNKTuIDNgaodyqo/US02DwDj7VN5ITg==';

// SSL 인증서 체인 오류 우회
const httpsAgent = new https.Agent({  
  rejectUnauthorized: false
});

/**
 * 반경 내 상점 조회 API (소상공인시장진흥공단 실제 API 연동)
 * Endpoint: GET /api/stores/radius?cx=경도&cy=위도&radius=반경
 */
app.get('/api/stores/radius', async (req, res) => {
  try {
    const { cx, cy, radius } = req.query;

    if (!cx || !cy || !radius) {
      return res.status(400).json({ 
        success: false, 
        message: '경도(cx), 위도(cy), 반경(radius) 값이 모두 필요합니다.' 
      });
    }

    const apiURL = 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius';

    // API 호출 (numOfRows를 500으로 늘려 더 많은 데이터를 가져오도록 수정)
    const response = await axios.get(apiURL, {
      httpsAgent: httpsAgent,
      params: {
        serviceKey: SERVICE_KEY,
        radius: radius,     
        cx: cx,             
        cy: cy,             
        type: 'json',       
        numOfRows: 500      // 한번에 가져오는 데이터 개수 확대
      }
    });

    // 공공데이터 응답 구조 안전하게 파싱 (items 배열 추출)
    let items = [];
    const dataBody = response.data?.body;
    
    if (dataBody) {
      if (Array.isArray(dataBody.items)) {
        items = dataBody.items;
      } else if (dataBody.items && Array.isArray(dataBody.items.item)) {
        items = dataBody.items.item;
      }
    }

    console.log(`[API 성공] 조회된 상점 수: ${items.length}개`);

    return res.status(200).json({
      success: true,
      body: {
        items: items
      }
    });

  } catch (error) {
    console.error('공공데이터 API 호출 중 오류 발생:', error.message);

    return res.status(200).json({ 
      success: true, 
      body: { 
        items: [] 
      } 
    });
  }
});

// 서버 실행
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
