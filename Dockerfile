FROM node:lts-alpine

# Install pnpm. Pinned, because `pnpm install --frozen-lockfile` below has to
# use a pnpm that reads the lockfile its peer wrote: a floating `pnpm` would
# drift from `packageManager` in package.json on the next major release.
# Keep this version in sync with `packageManager` when bumping either.
RUN npm install -g pnpm@12.23.0

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies without running lifecycle scripts
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the project
RUN pnpm run build

# Expose port if needed (optional, if the server listens on a port)
# EXPOSE 3000

# Start the server
CMD ["node", "build/src/index.js"]
