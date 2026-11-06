# 可信任第三方伺服程式
此程式是用在檔案搜尋時，提供給機敏雲端的伺服端與客戶端公共變數，並且提供客戶端搜尋密鑰的伺服器。具體的技術背景可以參考以下論文：
> J. Liu, Y. Fan, R. Sun, L. Liu, C. Wu and S. Mumtaz, "Blockchain-Aided Privacy-Preserving Medical Data Sharing Scheme for E-Healthcare System," in IEEE Internet of Things Journal, vol. 10, no. 24, pp. 21377-21388, 15 Dec.15, 2023, doi: 10.1109/JIOT.2023.3287636.
## 在本地建置
### 1. 安裝
執行`npm install`

### 2. 隱私性檔案設置
1. 新增`/data`資料夾，並在下面新增`tls.crt`, `tls.key`兩個檔案（可以參考[這裡](https://blog.miniasp.com/post/2019/02/25/Creating-Self-signed-Certificate-using-OpenSSL)）。

2. 新增`.env`檔案到`/data`資料夾下。此檔案為環境變數的設置，目前可以設定的變數為：
    ```
    SERVER_PORT=
    KEY_PATH=
    CERT_PATH=
    ```

### 3. 運行
1. 執行`node index.js`來運行可信任第三方伺服程式。

2. 執行`node CLI.js`來運行可信任第三方管理介面。