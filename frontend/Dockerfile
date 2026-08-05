FROM node:24-alpine

WORKDIR /app

# Copy only package files first so npm install is cached
# separately from source changes — rebuilds are much faster.
COPY package*.json ./
RUN npm install

# Source gets bind-mounted over this in docker-compose for dev,
# but copying it here means `docker build` alone still works standalone.
COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host"]
