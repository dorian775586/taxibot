const { Bot, Keyboard, InlineKeyboard, session, GrammyError, HttpError } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");
const dayjs = require("dayjs");
const axios = require("axios");

// --- ⚙️ НАСТРОЙКИ ---
const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 
const ADMIN_ID = 623203896; 

const bot = new Bot(token);

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri).then(() => console.log("✅ База подключена"));

const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String, 
    tariff: String, 
    city: String,
    isAllowed: { type: Boolean, default: false },
    expiryDate: { type: Date, default: null }, 
    username: String,
    regDate: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

bot.use(session({ initial: () => ({ step: "idle", tariff: null }) }));

const popularCities = ["Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург", "Казань", "Челябинск"];

// --- 🛠️ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function getCitiesKeyboard() {
    const kb = new InlineKeyboard();
    popularCities.forEach((city, i) => {
        kb.text(city, `regcity_${city}`);
        if ((i + 1) % 2 === 0) kb.row();
    });
    return kb;
}

// --- 🚀 ЛОГИКА БОТА ---

bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        ctx.session.step = "wait_tariff";
        const kb = new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime();
        await ctx.reply("🚕 Добро пожаловать! Выберите ваш рабочий тариф:", { reply_markup: kb });
    } else {
        const menu = new Keyboard().text("Открыть карту 🔥").row().text("Мой профиль 👤").resized();
        if (ctx.from.id === ADMIN_ID) menu.row().text("Список водителей 📋");
        
        const status = user.isAllowed ? "🟢 Доступ открыт" : "🔴 Ожидает одобрения";
        await ctx.reply(`🏠 **Главное меню**\nВаш статус: ${status}`, { reply_markup: menu, parse_mode: "Markdown" });
    }
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Регистрация города
    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        const count = await User.countDocuments();
        const user = new User({
            userId: ctx.from.id,
            username: ctx.from.username,
            tariff: ctx.session.tariff,
            city: city,
            name: `Водитель #${count + 1}`,
            isAllowed: false
        });
        await user.save();
        ctx.session.step = "idle";
        await ctx.editMessageText(`✅ Регистрация завершена!\n👤 Ваш позывной: <b>${user.name}</b>\n🏙 Город: <b>${city}</b>\n\n🚦 Ваша заявка будет одобрена администратором в ближайшее время. Ожидайте уведомления.`, { parse_mode: "HTML" });
        await bot.api.sendMessage(ADMIN_ID, `🔔 <b>Новая заявка:</b> ${user.name}\n📍 Город: ${city}\n💰 Тариф: ${user.tariff}`, { parse_mode: "HTML" });
    }

    // Управление водителем (Админка)
    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        if (!u) return ctx.answerCallbackQuery("Пользователь не найден");

        const exp = u.expiryDate ? dayjs(u.expiryDate).format("DD.MM.YYYY") : "—";
        const userLink = u.username ? `https://t.me/${u.username}` : `tg://user?id=${u.userId}`;

        const kb = new InlineKeyboard()
            .text("✅ Доступ (31д)", `allow_${tid}`)
            .text("🚫 Блок", `block_${tid}`).row()
            .text("🗑 Удалить профиль", `delete_${tid}`).row()
            .text("⬅️ Назад к списку", "back_to_list");

        await ctx.editMessageText(
            `👤 <b>${u.name}</b>\n` +
            `🔗 Профиль: <a href="${userLink}">${u.username || 'Ссылка'}</a>\n` +
            `🏙 Город: ${u.city}\n` +
            `💰 Тариф: ${u.tariff}\n` +
            `🔓 Доступ: ${u.isAllowed ? "✅ Да" : "❌ Нет"}\n` +
            `⏳ Истекает: ${exp}`, 
            { reply_markup: kb, parse_mode: "HTML" }
        );
    }

    if (data === "back_to_list") {
        const users = await User.find().sort({ regDate: -1 });
        const kb = new InlineKeyboard();
        users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row(); });
        await ctx.editMessageText("👥 Список водителей:", { reply_markup: kb });
    }

    // Выдача доступа / Блок
    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [act, tid] = data.split("_");
        const isAllow = act === "allow";
        const date = isAllow ? dayjs().add(31, 'day').toDate() : null;

        await User.findOneAndUpdate({ userId: tid }, { isAllowed: isAllow, expiryDate: date });
        
        try {
            await bot.api.sendMessage(tid, isAllow ? "✅ Администратор одобрил ваш доступ на 31 день! Теперь карта доступна." : "❌ Ваш доступ был временно ограничен администратором.");
        } catch(e) {}
        
        await ctx.answerCallbackQuery("Статус обновлен");
        // Возвращаемся в профиль пользователя
        ctx.callbackQuery.data = `manage_${tid}`;
        return bot.on("callback_query:data")(ctx); 
    }

    if (data.startsWith("delete_")) {
        const tid = data.split("_")[1];
        await User.findOneAndDelete({ userId: tid });
        await ctx.answerCallbackQuery("Профиль удален");
        await ctx.editMessageText("🗑 Профиль удален.", { reply_markup: new InlineKeyboard().text("⬅️ К списку", "back_to_list") });
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;

    if (text === "Открыть карта 🔥" || text === "Открыть карту 🔥") {
        const u = await User.findOne({ userId });
        const now = new Date();
        const hasAccess = userId === ADMIN_ID || (u?.isAllowed && u.expiryDate > now);

        if (hasAccess) {
            return ctx.reply("📍 Карта горячих точек готова к запуску!", { 
                reply_markup: new InlineKeyboard().webApp("Запустить HotMap", `${webAppUrl}?city=${encodeURIComponent(u?.city || 'Москва')}`) 
            });
        }
        return ctx.reply("🚫 Доступ к карте закрыт. Ваша заявка либо на проверке, либо срок доступа истек.");
    }

    if (text === "Мой профиль 👤") {
        const u = await User.findOne({ userId });
        if (!u) return;
        const exp = u.expiryDate ? dayjs(u.expiryDate).format("DD.MM.YYYY") : "Не активен";
        return ctx.reply(`👤 <b>Ваш профиль:</b>\n🆔 ID: <code>${u.name}</code>\n📍 Город: ${u.city}\n🚖 Тариф: ${u.tariff}\n⏳ Доступ до: ${exp}`, { parse_mode: "HTML" });
    }

    if (text === "Список водителей 📋" && userId === ADMIN_ID) {
        const users = await User.find().sort({ regDate: -1 }).limit(40);
        if (users.length === 0) return ctx.reply("В базе пока нет водителей.");
        const kb = new InlineKeyboard();
        users.forEach(u => { kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name}`, `manage_${u.userId}`).row(); });
        return ctx.reply("👥 <b>Список водителей:</b>\n<i>Нажмите на водителя для управления</i>", { reply_markup: kb, parse_mode: "HTML" });
    }

    // Выбор города после тарифа
    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        await ctx.reply("🏙 Отлично! Теперь выберите ваш рабочий город:", { reply_markup: getCitiesKeyboard() });
    }
});

bot.catch((err) => console.error("!!! ОШИБКА !!!", err));

bot.start({ drop_pending_updates: true });

// Простая заглушка для Render
http.createServer((req, res) => { res.end("OK"); }).listen(process.env.PORT || 8080);