# 機敏雲端伺服端程式

## 在本地建置
### 1. 安裝

執行`npm install`。

### 2. 隱私性檔案設置
1. 新增`/certs`資料夾，並在下面新增`tls.crt`, `tls.key`兩個檔案（可以參考[這裡](https://blog.miniasp.com/post/2019/02/25/Creating-Self-signed-Certificate-using-OpenSSL)）。
4. 新增`/ssh`資料夾，並在下面新增`id_ed25519`, `id_ed25519.pub`兩個檔案（可以參考[這裡](https://hackmd.io/@CynthiaChuang/Generating-a-Ssh-Key-and-Adding-It-to-the-Github)）。
3. 在`/config`資料夾下新增`local.yaml`。
    
    這個檔案是拿來覆蓋預設的`default.yaml`的，具體可以參考[這裡](https://github.com/node-config/node-config/wiki/Configuration-Files)。目前會需要設置的是：
    ```yaml
    database:
      ssl:
        rejectUnauthorized: false
    blockchain:
      jsonRpcUrl:
      contractAddr:
    smtp:
      host:
      user:
      pass:
      from:
    ```
    SMTP的部分請參考[這裡](https://www.mailersend.com/help/smtp-relay)建立一個可用的帳號。`smtp.from`可以是`<anything>@<your_domain>`。

### 3. 本地資料庫設置
1. 安裝`posgresql`。
2. 在裡面根據`database.sql`檔案新增資料庫。請注意資料庫名稱、擁有者、密碼等是否跟`default.yaml`內`database`設置的相同。若是不同，則需要在`local.yaml`內額外覆蓋設定。
4. 根據`sharedb.sql`建立三個資料庫，分別命名`secret_share1`, `secret_share2`, `secret_share3`。名稱與擁有者設定也要注意是否跟`default.yaml`內`database.secretShare`相同，或是在`local.yaml`中覆蓋。

### 4. 運行伺服端
執行`npm start`

## 建立docker image
`docker build -t="server" .` 
