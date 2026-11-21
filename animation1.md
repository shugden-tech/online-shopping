---
📜 Scroll & Layering Animation Guide
Энэхүү хэсэг нь бүтээгдэхүүнийг сонгохдоо ашиглагддаг "Layering Slider" бөгөөд GSAP болон CSS Transition-ийг хослуулсан ухаалаг бүтэцтэй.

1. Ерөнхий бүтэц (Architecture)
Container (uid=9373): Анимац явагдах үндсэн талбар. relative байрлалтай.
Scroll List (.slider-list): Бүтээгдэхүүнүүдийг агуулсан жагсаалт. Гар утасны хувилбарт overflow-y: scroll ашигладаг.
Animation Engine:
GSAP (GreenSock): Гүйлгэх (scroll) хөдөлгөөнийг зөөлрүүлэх (smoothing) болон 3D эффектийг удирдана.
Vue Hooks: useTrackScrollProgress ашиглан гүйлгэх явцыг (%) тооцоолно.
2. Анимацын төрлүүд (Animation Effects)
A. Entrance Animation (Орж ирэх хөдөлгөөн)
Бүтээгдэхүүний картууд нэгэн зэрэг биш, дарааллаар тодорч гарч ирдэг.

Property: opacity
Timing: 0.65s
Easing: cubic-bezier(0.445, 0.05, 0.55, 0.95) (Sine Ease-in-out)
Logic: Карт бүрт --delay хувьсагч оноож, өмнөхөөсөө бага зэрэг хожимдож гарч ирэхээр тохируулсан.
B. Scroll Masking (Гүйлгэх үеийн уусалт)
Жагсаалтыг дээш доош гүйлгэхэд дээд болон доод ирмэг дээрх бүтээгдэхүүнүүд зөөлөн уусч алга болно.

Method: mask-image (Linear Gradient)
Dynamic logic: Гүйлгэх явц (scroll progress) 0.015-аас 0.05 (дээд тал) болон 0.8-аас 1.0 (доод тал) хооронд байхад маскны тунгалаг чанар (alpha) өөрчлөгдөнө.
C. Swiper Transition (Слайдер хөдөлгөөн)
Ширээний хувилбарт (Desktop) бүтээгдэхүүнүүд creative-effect ашиглан солигдоно:

Transition: Төвөөс холдох тусам opacity: 0 болж, 7.5%-ийн шилжилт (translate) хийнэ.
3. Технологийн сан (Tech Stack)
GSAP ScrollToPlugin: Гүйлгэх байрлалыг удирдахад.
Swiper.js: Слайдерын үндсэн хөдөлгөөнд.
CSS Custom Properties: --delay зэрэг динамик утгуудыг дамжуулахад.
---
Хэрхэн хэрэгжүүлэх вэ?
CSS: transition: opacity 0.65s cubic-bezier(...) ашиглан картаа бэлдэнэ.
JS: window.addEventListener('scroll', ...) эсвэл GSAP-ийн ScrollTrigger-ээр гүйлгэх явцыг 0-1 хооронд барина.
Style: Гүйлгэх явцын утгыг ашиглан mask-image-ийн тунгалаг чанарыг динамикаар шинэчилнэ.
---