# 一次啟動/關閉三個子專案（PostgreSQL 需自行先啟動）
#   make run    依序啟動 Trusted Authority -> Cloud Server -> Electron Client
#   make stop   反序關閉 Client -> Cloud Server -> Trusted Authority
#   make status 查看目前狀態
#   make logs   跟蹤三份 log
#   make run-test   另開一個測試用 Client（獨立 profile，可註冊第二個帳號，例如一般使用者）
#   make stop-test  關閉測試用 Client
#   make reset-test 刪除測試用 Client 的本機資料（金鑰、錢包、設定），下次啟動可重新註冊

TA_DIR     := trusted-authority
SERVER_DIR := secure-cloud-storage-server
CLIENT_DIR := secure-cloud-storage-client

RUN_DIR := $(CURDIR)/.run
TA_PORT     := 2999
SERVER_PORT := 3001
# 測試用 Client 的 profile 名稱；userData 會變成 <預設 userData>-$(TEST_PROFILE)
TEST_PROFILE := test
TEST_USER_DATA := $(HOME)/Library/Application Support/client-side-$(TEST_PROFILE)

.PHONY: run stop status logs run-test stop-test reset-test _stop

run:
	@mkdir -p $(RUN_DIR)
	@wait_port() { \
	    i=0; \
	    while [ $$i -lt 30 ]; do \
	        nc -z localhost $$1 2>/dev/null && return 0; \
	        i=$$((i + 1)); sleep 1; \
	    done; \
	    return 1; \
	}; \
	start_one() { \
	    name=$$1; dir=$$2; shift 2; \
	    if [ -f $(RUN_DIR)/$$name.pid ] && kill -0 $$(cat $(RUN_DIR)/$$name.pid) 2>/dev/null; then \
	        echo "[$$name] 已在執行 (pid $$(cat $(RUN_DIR)/$$name.pid))，略過"; return 0; \
	    fi; \
	    echo "[$$name] 啟動中..."; \
	    ( cd $$dir && nohup env -u ELECTRON_RUN_AS_NODE "$$@" > $(RUN_DIR)/$$name.log 2>&1 & echo $$! > $(RUN_DIR)/$$name.pid ); \
	}; \
	start_one ta $(TA_DIR) node index.js || exit 1; \
	if wait_port $(TA_PORT); then echo "[ta] 已就緒 (port $(TA_PORT))"; \
	else echo "[ta] 等待 port $(TA_PORT) 逾時，請查看 .run/ta.log"; exit 1; fi; \
	start_one server $(SERVER_DIR) npm start || exit 1; \
	if wait_port $(SERVER_PORT); then echo "[server] 已就緒 (port $(SERVER_PORT))"; \
	else echo "[server] 等待 port $(SERVER_PORT) 逾時，請查看 .run/server.log"; exit 1; fi; \
	start_one client $(CLIENT_DIR) npm run dev || exit 1; \
	echo "三個服務都已啟動；log 在 .run/，用 make stop 關閉"

stop:
	@$(MAKE) --no-print-directory _stop NAMES="client-test client server ta"

stop-test:
	@$(MAKE) --no-print-directory _stop NAMES="client-test"

_stop:
	@stop_tree() { \
	    for c in $$(pgrep -P "$$1" 2>/dev/null); do stop_tree "$$c"; done; \
	    kill "$$1" 2>/dev/null || true; \
	}; \
	for name in $(NAMES); do \
	    pidfile=$(RUN_DIR)/$$name.pid; \
	    if [ -f $$pidfile ]; then \
	        pid=$$(cat $$pidfile); \
	        if kill -0 $$pid 2>/dev/null; then \
	            echo "[$$name] 關閉中 (pid $$pid)"; \
	            stop_tree $$pid; \
	        else \
	            echo "[$$name] 未在執行"; \
	        fi; \
	        rm -f $$pidfile; \
	    else \
	        echo "[$$name] 沒有 pid 檔，略過"; \
	    fi; \
	done

status:
	@for name in ta server client client-test; do \
	    pidfile=$(RUN_DIR)/$$name.pid; \
	    if [ -f $$pidfile ] && kill -0 $$(cat $$pidfile) 2>/dev/null; then \
	        echo "[$$name] 執行中 (pid $$(cat $$pidfile))"; \
	    else \
	        echo "[$$name] 未執行"; \
	    fi; \
	done

logs:
	@tail -n 20 -F $(RUN_DIR)/ta.log $(RUN_DIR)/server.log $(RUN_DIR)/client.log $(RUN_DIR)/client-test.log 2>/dev/null

# 第二個 Client：用 CLIENT_PROFILE 讓 userData 分開，等於另一台裝置、另一個帳號。
# 需要 Cloud Server 已在執行（先 make run）。
run-test:
	@mkdir -p $(RUN_DIR)
	@if ! nc -z localhost $(SERVER_PORT) 2>/dev/null; then \
	    echo "[client-test] Cloud Server (port $(SERVER_PORT)) 未啟動，請先 make run"; exit 1; \
	fi; \
	name=client-test; \
	if [ -f $(RUN_DIR)/$$name.pid ] && kill -0 $$(cat $(RUN_DIR)/$$name.pid) 2>/dev/null; then \
	    echo "[$$name] 已在執行 (pid $$(cat $(RUN_DIR)/$$name.pid))，略過"; exit 0; \
	fi; \
	echo "[$$name] 啟動中 (profile=$(TEST_PROFILE), userData=$(TEST_USER_DATA))..."; \
	( cd $(CLIENT_DIR) && nohup env -u ELECTRON_RUN_AS_NODE CLIENT_PROFILE=$(TEST_PROFILE) npm run dev > $(RUN_DIR)/$$name.log 2>&1 & echo $$! > $(RUN_DIR)/$$name.pid ); \
	echo "[$$name] 已啟動；log 在 .run/$$name.log，用 make stop-test 關閉"

# 清掉測試 profile 的本機資料（不會動到 Server 上的帳號；同一個 email 不能再註冊，換一個 email 或先刪 DB 使用者）
reset-test:
	@if [ -f $(RUN_DIR)/client-test.pid ] && kill -0 $$(cat $(RUN_DIR)/client-test.pid) 2>/dev/null; then \
	    echo "[client-test] 仍在執行，請先 make stop-test"; exit 1; \
	fi; \
	rm -rf "$(TEST_USER_DATA)"; \
	echo "已刪除 $(TEST_USER_DATA)"
