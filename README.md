# Focus Mirror

Focus Mirror is a browser-based focus tracker. It uses your camera to detect focus and drowsiness, provides alerts, and includes Pomodoro sessions.

## Run locally

```sh
npm install
npm run dev
```

Camera access requires HTTPS or `localhost`.

## Deploy

The site is published to [GitHub Pages](https://thisisaktar.github.io/focus-mirror/) from the `main` branch. The GitHub Actions workflow builds the Vite app and deploys the `dist` directory.
