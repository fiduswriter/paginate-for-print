FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Application parameters and variables
ENV NODE_ENV=development
ENV PORT=9090
ENV DIRECTORY /home/pwuser/paged-with-floats

# Configuration for Chrome
ENV CONNECTION_TIMEOUT=60000

# Configuration for GS4JS
RUN echo "GS4JS_HOME=/usr/lib/$(gcc -dumpmachine)"

# Install ghostscript
RUN apt-get update && \
		apt-get install -y build-essential make gcc g++ && \
		apt-get -y install ghostscript && apt-get clean && \
		apt-get install -y libgs-dev && \
		rm -rf /var/lib/apt/lists/*

# Font rendering configuration (aliases + hinting policy).
# The MS core fonts referenced by spec fixtures (Times New Roman, Arial,
# Courier New, ...) are installed below: DOM spec expectations such as page
# counts were calibrated against their metrics, and metric-compatible
# substitutes shift line breaks and pagination.
COPY docker-font.conf /etc/fonts/local.conf


# Install fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
RUN apt-get update && apt-get install -y wget --no-install-recommends \
    	&& apt-get install -y fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
			--no-install-recommends \
		&& rm -rf /var/lib/apt/lists/* \
		&& apt-get purge --auto-remove -y curl \
		&& rm -rf /src/*.deb

# MS core fonts (EULA accepted non-interactively; the fonts are freely
# redistributable per their original license).
RUN echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections && \
		apt-get update && \
		apt-get install -y ttf-mscorefonts-installer && \
		rm -rf /var/lib/apt/lists/* && \
		fc-cache -f

# helps prevent zombie chrome processes.
ADD https://github.com/Yelp/dumb-init/releases/download/v1.2.0/dumb-init_1.2.0_amd64 /usr/local/bin/dumb-init
RUN chmod +x /usr/local/bin/dumb-init

RUN apt-get update && \
		apt-get install -y vim && \
		rm -rf /var/lib/apt/lists/*

#RUN npm install npm@latest -g
RUN npm install -g node-gyp

RUN mkdir -p $DIRECTORY

# All running as root and as non-privileged user.
RUN chmod -R 777 $DIRECTORY

WORKDIR $DIRECTORY

COPY package.json package-lock.json $DIRECTORY/
RUN npm install
RUN GS4JS_HOME="/usr/lib/$(gcc -dumpmachine)" npm install ghostscript4js

COPY . $DIRECTORY

EXPOSE $PORT

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
