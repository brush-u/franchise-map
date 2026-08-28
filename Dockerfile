FROM node:18-slim

WORKDIR /usr/src/app

# package.json만 먼저 복사해서 의존성 설치 레이어를 캐싱한다 (코드만 바뀌면 npm install 다시 안 돎)
COPY package*.json ./
RUN npm install --omit=dev

# 나머지 소스 복사
COPY . .

# Cloud Run은 PORT 환경변수를 자동으로 주입한다 (기본 8080). server.js가 이미
# process.env.PORT || 3000 으로 되어 있어서 별도 코드 수정 없이 그대로 호환된다.
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
