const { Bot, Keyboard, InlineKeyboard, session } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");
const dayjs = require("dayjs"); // Для работы с датами

// --- ⚙️ НАСТРОЙКИ ---
const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 
const ADMIN_ID = 623203896; 

const bot = new Bot(token);

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri);

const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String,
    car: String,
    tariff: String,
    city: String, // Новое поле
    isAllowed: { type: Boolean, default: false },
    expiryDate: Date, // Дата окончания доступа
    username: String
});
const User = mongoose.model("User", userSchema);

bot.use(session({ initial: () => ({ step: "idle" }) }));

// --- 🛠️ ФУНКЦИИ ---

async function showMainMenu(ctx, user) {
    const menu = new Keyboard().text("Открыть карту 🔥").row().text("Мой профиль 👤");
    if (ctx.from.id === ADMIN_ID) menu.row().text("Список водителей 📋");
    
    let statusMsg = user.isAllowed ? "🟢 Доступ разрешен" : "🔴 Доступ закрыт";
    if (user.isAllowed && user.expiryDate) {
        statusMsg += `\n⏰ До конца: ${dayjs(user.expiryDate).diff(dayjs(), 'day')} дн.`;
    }

    await ctx.reply(`🏠 **Главное меню**\nСтатус: ${statusMsg}`, { reply_markup: menu.resized(), parse_mode: "Markdown" });
}

// --- 🚀 ОБРАБОТКА КОМАНД ---

bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        ctx.session.step = "wait_tariff";
        const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized();
        await ctx.reply("🚕 Привет! Выберите ваш тариф:", { reply_markup: kb });
    } else {
        await showMainMenu(ctx, user);
    }
});

// --- 📋 АДМИН-ПАНЕЛЬ ---

bot.hears("Список водителей 📋", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const users = await User.find();
    if (users.length === 0) return ctx.reply("Водителей пока нет.");

    const kb = new InlineKeyboard();
    users.forEach(u => {
        const circle = u.isAllowed ? "🟢" : "🔴";
        kb.text(`${circle} ${u.name || u.userId}`, `manage_${u.userId}`).row();
    });
    await ctx.reply("👥 **Список всех водителей:**", { reply_markup: kb, parse_mode: "Markdown" });
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("manage_")) {
        const targetId = data.split("_")[1];
        const user = await User.findOne({ userId: targetId });
        
        const status = user.isAllowed ? "🟢 Активен" : "🔴 Заблокирован";
        const expiry = user.expiryDate ? dayjs(user.expiryDate).format("DD.MM.YYYY") : "Нет данных";
        
        const kb = new InlineKeyboard()
            .text("✅ Открыть (31 день)", `allow_${targetId}`)
            .text("🚫 Закрыть доступ", `block_${targetId}`).row()
            .text("⬅️ Назад", "back_to_list");

        await ctx.editMessageText(
            `👤 **Профиль водителя:**\n\nИмя: ${user.name}\nГород: ${user.city}\nАвто: ${user.car}\nТариф: ${user.tariff}\nСтатус: ${status}\nДоступ до: ${expiry}`,
            { reply_markup: kb, parse_mode: "Markdown" }
        );
    }

    if (data === "back_to_list") {
        const users = await User.find();
        const kb = new InlineKeyboard();
        users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row(); });
        await ctx.editMessageText("👥 Список всех водителей:", { reply_markup: kb });
    }

    // Логика кнопок внутри профиля
    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [action, targetId] = data.split("_");
        const isAllow = action === "allow";
        const expiry = isAllow ? dayjs().add(31, 'day').toDate() : null;

        await User.findOneAndUpdate({ userId: targetId }, { isAllowed: isAllow, expiryDate: expiry });
        
        const msg = isAllow 
            ? "🎉 Администратор открыл вам доступ на 31 день! Карта активна. 🚕" 
            : "❌ Ваш доступ к карте был приостановлен администратором.";
        
        await bot.api.sendMessage(targetId, msg).catch(() => {});
        await ctx.answerCallbackQuery(`Готово: ${isAllow ? "Доступ открыт" : "Доступ закрыт"}`);
        await ctx.editMessageText(`✅ Статус изменен для ${targetId}`);
    }
});

// --- 📝 РЕГИСТРАЦИЯ ---

bot.on("message:text", async (ctx, next) => {
    const text = ctx.msg.text;
    if (["Открыть карту 🔥", "Мой профиль 👤", "Список водителей 📋"].includes(text)) {
        ctx.session.step = "idle";
        return next();
    }

    let user = await User.findOne({ userId: ctx.from.id });
    if (!user && ctx.session.step === "wait_tariff") user = new User({ userId: ctx.from.id });

    switch (ctx.session.step) {
        case "wait_tariff":
            user.tariff = text;
            ctx.session.step = "wait_city";
            await ctx.reply("🏙 В каком городе будете работать?");
            await user.save();
            break;
        case "wait_city":
            user.city = text;
            ctx.session.step = "wait_name";
            await ctx.reply("📝 Введите ваше ФИО:");
            await user.save();
            break;
        case "wait_name":
            user.name = text;
            ctx.session.step = "wait_car";
            await ctx.reply("🚗 Введите марку и госномер машины:");
            await user.save();
            break;
        case "wait_car":
            user.car = text;
            ctx.session.step = "idle";
            await user.save();
            await ctx.reply("🏁 Заявка отправлена! Ожидайте подтверждения.");
            await bot.api.sendMessage(ADMIN_ID, `🔔 Новая заявка: ${user.name} (${user.city})\nПосмотри в "Список водителей 📋"`);
            await showMainMenu(ctx, user);
            break;
    }
});

// --- 🔥 ПРОВЕРКА ДОСТУПА (С АВТО-БЛОКОМ) ---

bot.hears("Открыть карту 🔥", async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    
    if (user && user.isAllowed) {
        // Проверка на просрочку
        if (user.expiryDate && dayjs().isAfter(dayjs(user.expiryDate))) {
            user.isAllowed = false;
            await user.save();
            return ctx.reply("⌛️ Срок вашего доступа (31 день) истек. Обратитесь к администратору.");
        }
        
        const webKeyboard = new InlineKeyboard().webApp("Запустить карту", webAppUrl);
        await ctx.reply("📍 Карта активна! Удачной смены!", { reply_markup: webKeyboard });
    } else {
        await ctx.reply("🚫 Доступ закрыт.");
    }
});

bot.hears("Мой профиль 👤", async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    const exp = user.expiryDate ? dayjs(user.expiryDate).format("DD.MM.YYYY") : "Нет доступа";
    await ctx.reply(`👤 **Профиль:**\n📍 Город: ${user.city}\n🚖 Тариф: ${user.tariff}\n🚗 Авто: ${user.car}\n⏳ Доступ до: ${exp}`, { parse_mode: "Markdown" });
});

bot.start();
http.createServer((req, res) => { res.end("Bot is alive!"); }).listen(process.env.PORT || 8080);