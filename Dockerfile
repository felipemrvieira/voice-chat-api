# Dockerfile
FROM node:20-alpine

# Define diretório
WORKDIR /app

# Copia package.json e instala deps
COPY package*.json ./
RUN npm install

# Copia o resto
COPY . .

# Expondo porta da API
EXPOSE 3001

# Comando padrão
CMD ["npx", "nodemon", "server.js"]
