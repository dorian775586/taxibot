const { Bot, Keyboard, InlineKeyboard, session } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");

// --- ⚙️ НАСТРОЙКИ ---
const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 
const ADMIN_ID = 623203896; 

const bot = new Bot(token);

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri)
    .then(() => console.log("✅ База данных подключена успешно!"))
    .catch(err => console.error("❌ Ошибка БД:", err));

const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: String,
    car: String,
    tariff: String,
    isAllowed: { type: Boolean, default: false },
    username: String
});
const User = mongoose.model("User", userSchema);

// --- 🧠 СЕССИИ ---
bot.use(session({ initial: () => ({ step: "idle" }) }));

// --- 🛠️ ЛОГИКА БОТА ---

// Функция главного меню
async function showMainMenu(ctx, user) {
    const status = user.isAllowed ? "🟢 Доступ разрешен" : "🔴 Доступ ограничен (ждите активации)";
    const menu = new Keyboard()
        .text("Открыть карту 🔥").row()
        .text("Мой профиль 👤").resized();
    
    await ctx.reply(`🏠 **Главное меню**\n\nСтатус: ${status}`, { 
        reply_markup: menu,
        parse_mode: "Markdown"
    });
}

// Команда /start
bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });

    if (!user) {
        ctx.session.step = "wait_tariff";
        const tariffKb = new Keyboard()
            .text("Эконом 🚕").text("Комфорт ✨").row()
            .text("Комфорт+ ⚡").text("Элит 💎").resized().oneTime();
        
        await ctx.reply("👋 Привет! Добро пожаловать.\nДля доступа к карте нужно пройти быструю регистрацию.\n\n👇 **Выбери свой тариф:**", { 
            reply_markup: tariffKb,
            parse_mode: "Markdown"
        });
    } else {
        await showMainMenu(ctx, user);
    }
});

// 1. СНАЧАЛА проверяем кнопки меню (чтобы они не попадали в регистрацию)
bot.hears("Мой профиль 👤", async (ctx) => {
    ctx.session.step = "idle"; // Сбрасываем шаг на всякий случай
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) return ctx.reply("Зарегистрируйтесь через /start ✍️");
    
    const status = user.isAllowed ? "✅ Активен" : "⏳ На проверке";
    await ctx.reply(`👤 **Ваш профиль:**\n\n🗂 Тариф: ${user.tariff}\n📝 ФИО: ${user.name}\n🚗 Авто: ${user.car}\n🔓 Статус: ${status}`, {
        parse_mode: "Markdown"
    });
});

bot.hears("Открыть карту 🔥", async (ctx) => {
    ctx.session.step = "idle";
    const user = await User.findOne({ userId: ctx.from.id });
    
    if (user && user.isAllowed) {
        const webKeyboard = new InlineKeyboard().webApp("🚀 Запустить карту", webAppUrl);
        await ctx.reply("📍 Карта загружена! Нажмите кнопку ниже для запуска. Удачной смены! 👇", { reply_markup: webKeyboard });
    } else {
        await ctx.reply("🚫 **Доступ закрыт.**\n\nВаша заявка еще не одобрена или доступ был ограничен администратором. 👨‍💻", {
            parse_mode: "Markdown"
        });
    }
});

// 2. ЗАТЕМ админ-команды
bot.on("message:text", async (ctx, next) => {
    if (ctx.from.id !== ADMIN_ID) return next();

    if (ctx.msg.text.startsWith("/allow_")) {
        const targetId = ctx.msg.text.split("_")[1];
        await User.findOneAndUpdate({ userId: targetId }, { isAllowed: true });
        await ctx.reply(`✅ Доступ для пользователя ${targetId} **открыт**!`);
        await bot.api.sendMessage(targetId, "🎉 Поздравляем! Администратор открыл вам доступ к карте. Погнали! 🚕🔥");
    }

    if (ctx.msg.text.startsWith("/block_")) {
        const targetId = ctx.msg.text.split("_")[1];
        await User.findOneAndUpdate({ userId: targetId }, { isAllowed: false });
        await ctx.reply(`⚠️ Пользователь ${targetId} **заблокирован**.`);
        await bot.api.sendMessage(targetId, "❌ Ваш доступ к карте был приостановлен администратором.");
    }
    return next();
});

// 3. И В ПОСЛЕДНЮЮ ОЧЕРЕДЬ обработка регистрации
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
            await ctx.reply("📝 Принято! Теперь напишите ваше **ФИО**:", { 
                reply_markup: { remove_keyboard: true },
                parse_mode: "Markdown"
            });
            await user.save();
            break;

        case "wait_name":
            user.name = ctx.msg.text;
            ctx.session.step = "wait_car";
            await ctx.reply("🚗 Отлично. Введите **марку и госномер** вашей машины:", {
                parse_mode: "Markdown"
            });
            await user.save();
            break;

        case "wait_car":
            user.car = ctx.msg.text;
            ctx.session.step = "idle";
            await user.save();
            await ctx.reply("🏁 **Регистрация завершена!**\n\nВаши данные отправлены на проверку. Мы сообщим, когда доступ будет открыт! 🕒", {
                parse_mode: "Markdown"
            });
            await showMainMenu(ctx, user);
            
            // Уведомление админу
            await bot.api.sendMessage(ADMIN_ID, `🔔 **Новая заявка!**\n\n🚕 Тариф: ${user.tariff}\n👤 Имя: ${user.name}\n🚘 Авто: ${user.car}\n🆔 ID: ${userId}\n\nЧтобы дать доступ: /allow_${userId}\nЧтобы заблокировать: /block_${userId}`, {
                parse_mode: "Markdown"
            });
            break;
    }
});

bot.start();
console.log("🚀 Бот успешно запущен!");

// Сервер для Render
http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is alive and healthy!");
}).listen(process.env.PORT || 8080);