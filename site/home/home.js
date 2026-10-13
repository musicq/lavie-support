// lifebar.app homepage: reveal on scroll, the hero parallax, the word-by-word
// statement, the sticky phone story, count-ups and the gallery arrows.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nav = document.querySelector('.hnav');

  // Reveal: fade elements in once as they enter the viewport.
  const revealed = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      entry.target.querySelectorAll('.count').forEach(countUp);
      if (entry.target.matches('.count')) countUp(entry.target);
      revealed.unobserve(entry.target);
    }
  }, { threshold: 0.18, rootMargin: '0px 0px -6% 0px' });
  document.querySelectorAll('.rv, .bar, .tile').forEach((el) => revealed.observe(el));

  // Count-ups: "$1,922" rises from zero the first time it's seen.
  function countUp(el) {
    if (el.dataset.done || reduce) return;
    el.dataset.done = '1';
    const to = Number(el.dataset.to);
    const start = performance.now();
    const duration = 1300;
    const format = (n) => '$' + Math.round(n).toLocaleString('en-US');
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = format(to * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // The statement: split into words, light them as the paragraph scrolls by.
  const words = document.getElementById('words');
  let wordEls = [];
  if (words) {
    const build = (node) => {
      const frag = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.append(part); return; }
        const span = document.createElement('span');
        span.className = 'w' + (node.parentElement.classList.contains('em') ? ' em' : '');
        span.textContent = part;
        frag.append(span);
      });
      node.replaceWith(frag);
    };
    const texts = [];
    const walker = document.createTreeWalker(words, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(build);
    wordEls = [...words.querySelectorAll('.w')];
  }

  // Sticky story: whichever step sits in the middle of the screen picks the phone screen.
  const screens = [...document.querySelectorAll('#storyScreen picture')];
  const steps = [...document.querySelectorAll('.step')];
  const stepWatch = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = Number(entry.target.dataset.i);
      steps.forEach((s) => s.classList.toggle('on', s === entry.target));
      screens.forEach((p, i) => p.classList.toggle('off', i !== index));
    }
  }, { rootMargin: '-45% 0px -45% 0px' });
  steps.forEach((s) => stepWatch.observe(s));

  // Scroll-linked: the hero phone lifts and the chips drift apart; the words light up.
  const stage = document.getElementById('stage');
  let ticking = false;
  const onScroll = () => {
    ticking = false;
    const y = window.scrollY;
    nav.classList.toggle('scrolled', y > 8);
    if (reduce) return;
    if (stage) {
      const progress = Math.min(1, Math.max(0, y / (stage.offsetTop + stage.offsetHeight * 0.6)));
      stage.style.setProperty('--hp', progress.toFixed(3));
    }
    if (wordEls.length) {
      const rect = words.getBoundingClientRect();
      const vh = window.innerHeight;
      // Starts when the paragraph's top reaches 85% of the screen, ends at 35%.
      const p = Math.min(1, Math.max(0, (vh * 0.85 - rect.top) / (rect.height + vh * 0.5)));
      const lit = Math.round(p * wordEls.length);
      wordEls.forEach((w, i) => w.classList.toggle('on', i < lit));
    }
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  onScroll();

  // Gallery arrows.
  const gallery = document.getElementById('gallery');
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  if (gallery && prev && next) {
    const step = () => (gallery.querySelector('.slide')?.offsetWidth || 300) + 36;
    prev.addEventListener('click', () => gallery.scrollBy({ left: -step(), behavior: reduce ? 'auto' : 'smooth' }));
    next.addEventListener('click', () => gallery.scrollBy({ left: step(), behavior: reduce ? 'auto' : 'smooth' }));
    const update = () => {
      prev.disabled = gallery.scrollLeft < 8;
      next.disabled = gallery.scrollLeft + gallery.clientWidth > gallery.scrollWidth - 8;
    };
    gallery.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }
})();
