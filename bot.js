const { Bot, Keyboard, InlineKeyboard, session } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");

// --- НАСТРОЙКИ ---
const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
// ВСТАВЬ СВОЙ ПАРОЛЬ НИЖЕ
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 
const ADMIN_ID = 623203896; // Твой ID из @userinfobot

const bot = new Bot(token);

// --- БАЗА ДАННЫХ ---
mongoose.connect(mongoUri)
    .then(() => console.log("База данных подключена!"))
    .catch(err => console.error("Ошибка БД:", err));

const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String,
    car: String,
    tariff: String,
    isAllowed: { type: Boolean, default: false },
    username: String
});
const User = mongoose.model("User", userSchema);

// --- СЕССИИ ---
bot.use(session({ initial: () => ({ step: "idle" }) }));

// --- ЛОГИКА БОТА ---

// Главное меню
async function showMainMenu(ctx, user) {
    const status = user.isAllowed ? "✅ Доступ разрешен" : "❌ Доступ запрещен (ожидайте активации)";
    const menu = new Keyboard()
        .text("Открыть карту 🔥").row()
        .text("Мой профиль 👤").resized();
    
    await ctx.reply(`Главное меню\nСтатус: ${status}`, { reply_markup: menu });
}

bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });

    if (!user) {
        ctx.session.step = "wait_tariff";
        const tariffKb = new Keyboard()
            .text("Эконом").text("Комфорт").row()
            .text("Комфорт+").text("Элит").resized().oneTime();
        
        await ctx.reply("Привет! Пройди регистрацию, чтобы получить доступ к карте.\n\nВыбери свой тариф:", { reply_markup: tariffKb });
    } else {
        await showMainMenu(ctx, user);
    }
});

// Обработка регистрации
bot.on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    let user = await User.findOne({ userId });

    if (!user && ctx.session.step === "wait_tariff") {
        user = new User({ userId, username: ctx.from.username });
    }

    switch (ctx.session.step) {
        case "wait_tariff":
            user.tariff = ctx.msg.text;
            ctx.session.step = "wait_name";
            await ctx.reply("Введите ваше ФИО:", { reply_markup: { remove_keyboard: true } });
            await user.save();
            break;

        case "wait_name":
            user.name = ctx.msg.text;
            ctx.session.step = "wait_car";
            await ctx.reply("Введите марку и госномер вашей машины:");
            await user.save();
            break;

        case "wait_car":
            user.car = ctx.msg.text;
            ctx.session.step = "idle";
            await user.save();
            await ctx.reply("✅ Регистрация завершена! Данные отправлены админу. Ожидайте подтверждения.");
            await showMainMenu(ctx, user);
            
            // Уведомление админу
            await bot.api.sendMessage(ADMIN_ID, `🔔 Новая заявка!\nТариф: ${user.tariff}\nИмя: ${user.name}\nАвто: ${user.car}\nID: ${userId}\n\nЧтобы дать доступ: /allow_${userId}\nЧтобы заблокировать: /block_${userId}`);
            break;
    }
});

// Профиль
bot.hears("Мой профиль 👤", async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) return;
    const status = user.isAllowed ? "✅ Разрешен" : "❌ Запрещен";
    await ctx.reply(`👤 Ваш профиль:\n\nТариф: ${user.tariff}\nФИО: ${user.name}\nАвто: ${user.car}\nДоступ: ${status}`);
});

// Открытие карты
bot.hears("Открыть карту 🔥", async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    if (user && user.isAllowed) {
        const webKeyboard = new InlineKeyboard().webApp("Запустить карту", webAppUrl);
        await ctx.reply("Карта активна. Удачной смены! 👇", { reply_markup: webKeyboard });
    } else {
        await ctx.reply("⚠️ Доступ закрыт. Обратитесь к администратору для активации.");
    }
});

// --- АДМИН-КОМАНДЫ ---
bot.on("message:text", async (ctx, next) => {
    if (ctx.from.id !== ADMIN_ID) return next();

    if (ctx.msg.text.startsWith("/allow_")) {
        const targetId = ctx.msg.text.split("_")[1];
        await User.findOneAndUpdate({ userId: targetId }, { isAllowed: true });
        await ctx.reply(`Доступ для ${targetId} активирован!`);
        await bot.api.sendMessage(targetId, "🎉 Администратор открыл вам доступ к карте! Можете приступать.");
    }

    if (ctx.msg.text.startsWith("/block_")) {
        const targetId = ctx.msg.text.split("_")[1];
        await User.findOneAndUpdate({ userId: targetId }, { isAllowed: false });
        await ctx.reply(`Доступ для ${targetId} закрыт.`);
        await bot.api.sendMessage(targetId, "❌ Ваш доступ к карте был приостановлен.");
    }
});

bot.start();
console.log("Бот запущен...");

// Сервер для Render
http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is alive!");
}).listen(process.env.PORT || 8080);