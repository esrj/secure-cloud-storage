/**
 * This file handles the command line interface for managing user attribute and attribute names.
 */
import { input, select, confirm, checkbox } from "@inquirer/prompts";
import Table from "tty-table";
import winston, { format } from "winston";
import Database from "better-sqlite3";

const logger = winston.createLogger({
  //   level: process.env.NODE_ENV !== 'production' ? 'debug' : 'info',
  format: winston.format.combine(
    format.errors({ stack: true }),
    format.timestamp(),
    format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: "admin.log",
      dirname: "data",
    }),
  ],
});

const db = new Database("data/TA.db");
const getAttrs = db.prepare(`SELECT id, u FROM array_params WHERE u != 'EOF';`);
const updateAttr = db.prepare(`UPDATE array_params SET u = ? WHERE id = ?;`);
const getUserAttrIds = db.prepare(
  `SELECT attrid FROM user_attr WHERE userid = ?;`
);
const removeUserAttrId = db.prepare(
  `DELETE FROM user_attr WHERE userid = ? AND attrid = ?;`
);
const insertUserAttrId = db.prepare(
  `INSERT INTO user_attr (userid, attrid) VALUES (?, ?);`
);

function showAndLogError(error, actionStr) {
  console.log(`發生錯誤：`);
  console.log(error);
  logger.error(error, { actionStr });
}

function exitProgram() {
  logger.info(`Command line interface exited.`);
  console.groupEnd();
  console.log(`已離開程式`);
  process.exit(0);
}

function handleCtrlCError(error) {
  if (error instanceof Error && error.name == "ExitPromptError") exitProgram();
}

function chunk(arr, size) {
  let chunks = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, Math.min(i + size, arr.length)));
  }
  const originalLength = chunks.at(-1).length;
  chunks.at(-1).length = size;
  chunks.at(-1).fill("(None)", originalLength);
  return chunks;
}

async function globalActions() {
  const attrColumns = 8;
  let attrs = getAttrs.all();
  const attrHeader = Array(attrColumns).fill({
    formatter: function (value) {
      if (value.newU) {
        if (value.u == "None")
          return this.style(value.newU, "greenBright", "bold");
        else return this.style(`${value.u} -> ${value.newU}`, "red");
      }
      return value.u == "None"
        ? this.style(value.u, "dim")
        : this.style(value.u, "cyan");
    },
  });
  function findAttr(newAttr) {
    return attrs.find((attr) => attr.u == newAttr || attr.newU == newAttr);
  }
  function showAttrs() {
    const p = new Table(attrHeader, chunk(attrs, attrColumns), {
      showHeader: false,
    }).render();
    console.log(p);
    console.log("");
  }

  let dirty = false;
  while (true) {
    let globalAction = null;
    try {
      globalAction = await select({
        message: "選擇要執行的指令",
        choices: [
          { name: "查看所有屬性", value: "get-all-attr" },
          { name: "暫存新增屬性", value: "add-attr" },
          { name: "暫存改變屬性", value: "change-attr" },
          { name: "應用變更", value: "apply-change", disabled: !dirty },
          { name: "丟棄變更", value: "discard-change", disabled: !dirty },
          { name: "返回", value: "return" },
        ],
      });
      switch (globalAction) {
        case "get-all-attr":
          showAttrs();
          break;
        case "add-attr":
          {
            console.log(
              `請輸入要新增的屬性，並以空格隔開（如：屬性一 屬性二）`
            );
            console.log(
              `注意！屬性總數有上限，超過便無法新增。目前剩餘空位：${
                attrs.filter((attr) => attr.u == "None").length
              }`
            );
            console.log(`若要取消新增，請直接按下Enter`);
            const newAttrs = (await input({ message: "要新增的屬性" }))
              .trim()
              .split(" ")
              .filter((item) => item != "");
            if (newAttrs.length == 0) break;

            const addedAttr = [];
            for (let i = 0; i < newAttrs.length; i++) {
              const emptyAttr = attrs.find(
                (attr) => attr.u == "None" && !attr.newU
              );
              if (!emptyAttr) {
                console.log(`屬性總數已達上限！以下屬性將不會被新增：`);
                console.log(`${newAttrs.slice(i).join(" ")}`);
                break;
              }
              if (findAttr(newAttrs[i])) {
                console.log(`${newAttrs[i]} 已存在，將不會被新增`);
                continue;
              }

              attrs[emptyAttr.id].newU = newAttrs[i];
              addedAttr.push(newAttrs[i]);
              dirty = true;
            }
            if (addedAttr.length != 0) {
              showAttrs();
              console.log(`成功暫存以下新增屬性：`);
              console.log(addedAttr.join(" "));
              console.log(`後續請應用變更\n`);
            } else {
              console.log(`沒有新增屬性`);
            }
          }
          break;
        case "change-attr":
          {
            console.log(`請輸入要變更的屬性`);
            console.log(
              `注意！所有檔案擁有的該屬性皆會變更成新的屬性！請小心使用！`
            );
            console.log(`若要取消變更，請直接按下Enter`);
            let attrToChange = "";
            while (true) {
              attrToChange = (
                await input({
                  message: "要變更的屬性",
                  default: attrToChange,
                })
              ).trim();
              if (attrToChange == "") break;
              const matchSourceAttr = findAttr(attrToChange);
              if (!matchSourceAttr || attrToChange == "None") {
                console.log(`屬性 ${attrToChange} 不存在`);
                attrToChange = "";
                continue;
              }
              let done = false;
              while (true) {
                const attrChangeTo = (
                  await input({ message: "要變更成的屬性" })
                ).trim();
                if (attrChangeTo == "") break;
                if (attrChangeTo == "None" || attrChangeTo == "EOF") {
                  console.log(`屬性不可為 ${attrChangeTo}`);
                  continue;
                }
                if (findAttr(attrChangeTo)) {
                  console.log(`屬性 ${attrChangeTo} 已存在`);
                  continue;
                }
                attrs[matchSourceAttr.id].newU = attrChangeTo;
                done = true;
                showAttrs();
                console.log(`屬性 ${attrToChange} 成功變更為 ${attrChangeTo}`);
                console.log(`後續請應用變更\n`);
                dirty = true;
                break;
              }
              if (done) break;
            }
          }
          break;
        case "apply-change":
          {
            const yes = await confirm({
              message: `確認要應用變更嗎？`,
            });
            if (!yes) break;
            const modifiedAttrs = attrs.filter(
              (attr) => attr.newU != undefined
            );
            modifiedAttrs.forEach((attr) => {
              updateAttr.run(attr.newU, attr.id);
            });
            logger.info(`Global attributes modified.`, {
              modifiedAttrs: modifiedAttrs.map((attr) => {
                return { originalAttr: attr.u, modifiedTo: attr.newU };
              }),
            });
            attrs = getAttrs.all();
            dirty = false;
            showAttrs();
          }
          break;
        case "discard-change":
          {
            const yes = await confirm({
              message: `確認要丟棄變更嗎？`,
            });
            if (!yes) break;
            attrs.forEach((attr) => {
              delete attr.newU;
            });
            console.log(`變更已丟棄`);
            dirty = false;
          }
          break;
        case "return":
          if (dirty) {
            const yes = await confirm({
              message: `尚有未應用的變更，確定要返回嗎？`,
            });
            if (!yes) break;
            else console.log(`變更已丟棄`);
          }
          return;
      }
    } catch (error) {
      handleCtrlCError(error);
      showAndLogError(error, globalAction);
    }
  }
}

// Get user attribute
// add user attribute (can be used like add 普通 機密)
// Will check if exist in global attributes
// remove user attribute (can be used like remove 普通 機密)
async function userActions() {
  const attrs = getAttrs.all();
  const validAttrs = attrs.filter((attr) => attr.u != "None");
  const uuidFormatRe =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  async function getUserIdInput() {
    while (true) {
      const userId = (
        await input({
          message: `請輸入使用者ID，或直接按下Enter以離開`,
        })
      ).trim();
      if (userId == "") return null;
      if (!uuidFormatRe.test(userId)) {
        console.log(
          `使用者ID格式不正確。需為UUIDv4格式(xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)`
        );
        continue;
      }
      return userId;
    }
  }
  function showUserAttrs(userId) {
    const userAttrIds = getUserAttrIds.all(userId).map((row) => row.attrid);
    console.log(`使用者 ${userId} 的屬性如下：`);
    console.log(userAttrIds.map((attrid) => attrs[attrid].u).join(" "));
    console.log("")
  }

  while (true) {
    let userAction = null;
    try {
      userAction = await select({
        message: "選擇要執行的指令",
        choices: [
          { name: "查看使用者屬性", value: "get-user-attr" },
          { name: "變更使用者屬性", value: "modify-user-attr" },
          { name: "返回", value: "return" },
        ],
      });
      switch (userAction) {
        case "get-user-attr":
          {
            const userId = await getUserIdInput();
            if (!userId) break;
            showUserAttrs(userId);
          }
          break;
        case "modify-user-attr":
          {
            const userId = await getUserIdInput();
            if (!userId) break;
            const userAttrIds = getUserAttrIds
              .all(userId)
              .map((row) => row.attrid);
            const modifiedAttrIds = await checkbox({
              message: "變更使用者屬性：",
              choices: validAttrs.map((attr) => {
                return {
                  name: attr.u,
                  value: attr.id,
                  checked: userAttrIds.includes(attr.id),
                };
              }),
            });
            const addedAttrIds = modifiedAttrIds.filter(
              (attrId) => !userAttrIds.includes(attrId)
            );
            const removedAttrIds = userAttrIds.filter(
              (attrId) => !modifiedAttrIds.includes(attrId)
            );
            console.log(
              `將會為使用者新增屬性：${addedAttrIds
                .map((attrId) => attrs[attrId].u)
                .join(" ")}`
            );
            console.log(
              `將會為使用者移除屬性：${removedAttrIds
                .map((attrId) => attrs[attrId].u)
                .join(" ")}`
            );
            console.log(
              `使用者最終屬性：${modifiedAttrIds
                .map((attrId) => attrs[attrId].u)
                .join(" ")}`
            );
            const yes = await confirm({
              message: "確定要執行以上變更嗎？",
            });
            if (!yes) {
              console.log(`變更已取消`);
            } else {
              removedAttrIds.forEach((attrId) => {
                removeUserAttrId.run(userId, attrId);
              });
              addedAttrIds.forEach((attrId) => {
                insertUserAttrId.run(userId, attrId);
              });
              console.log(`變更已成功`);
              logger.info(`User attributes modified.`, {
                added: addedAttrIds.map((attrid) => attrs[attrid].u),
                removed: removedAttrIds.map((attrid) => attrs[attrid].u),
              });
              showUserAttrs(userId);
            }
          }
          break;
        case "return":
          return;
          break;
      }
    } catch (error) {
      handleCtrlCError(error);
      showAndLogError(error);
    }
  }
}

logger.info(`Command line interface started.`);
console.group();

while (true) {
  let adminAction = null;
  try {
    adminAction = await select({
      message: "選擇要執行的指令",
      choices: [
        { name: "全域相關", value: "global" },
        { name: "使用者相關", value: "user" },
        { name: "離開", value: "exit" },
      ],
    });
    switch (adminAction) {
      case "global":
        await globalActions();
        break;
      case "user":
        await userActions();
        break;
      case "exit":
        exitProgram();
        break;
    }
  } catch (error) {
    handleCtrlCError(error);
    showAndLogError(error, adminAction);
  }
}
