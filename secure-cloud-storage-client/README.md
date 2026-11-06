# 機敏雲端客戶端


## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## 在本地建置

### 1. 安裝

```bash
$ npm install
```

### 2. 開發運行

```bash
$ npm run dev
```
In order to test with multiple instances, set `NODE_APP_INSTANCE=N`, and configure `local-n.yaml` in the config folder.
Usage: 
```bash
#Instance 1
$ npm run dev
```
```bash
#Instance 2
$ NODE_APP_INSTANCE=2 npm run dev
```
local-2.yaml:
```yaml
keys:
  path: user2.keys
blockchain:
  walletKeyFilename: wallet2.key
```

### 備註
使用者相關資料會存在

1. linux `~/.config/client-side`
1. windows `%APPDATA%\client-side`
### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
