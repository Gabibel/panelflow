// Who runs PanelFlow, written once.
//
// The three legal pages each have to say who the publisher is, how to reach
// them, and who hosts the thing. The law (LCEN art. 6-III, RGPD art. 13)
// wants those to be true, not approximately true. Three pages copying the same
// address is how one of them ends up out of date, so they carry `data-legal`
// marks instead and this file fills them.
//
// TO THE OPERATOR: `contact` is the one value nobody else can write for you.
// Until it is set, every page shows a visible "à renseigner" mark where the
// address should be. That is deliberately visible: a legal page quietly
// missing its contact is worse than one that says so. Set it, redeploy, done.
(() => {
  'use strict';

  const LEGAL = {
    // How the publisher is named on the pages. A person publishing as a
    // non-professional may keep name and address off the page under LCEN
    // art. 6-III-2, provided the host is identified and holds them, which is
    // what the mentions page says. The name below is the public one.
    publisher: 'PanelFlow',
    // An address readers can write to for their data (RGPD art. 13.1.a) and
    // for notices about content (LCEN art. 6-I-5). One address is enough.
    contact: '1animoment@gmail.com',
    host: {
      name: 'Vercel Inc.',
      address: '440 N Barranca Ave #4133, Covina, CA 91723, États-Unis',
      site: 'https://vercel.com',
      region: 'Dublin, Irlande (région de déploiement dub1)',
    },
    // The public address of the service, for the "you are here" line.
    site: 'https://panelflow-backend.vercel.app',
    updated: '18 septembre 2026',
  };

  const value = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), LEGAL);

  const fill = () => {
    for (const el of document.querySelectorAll('[data-legal]')) {
      const v = value(el.dataset.legal);
      if (v) {
        el.textContent = v;
        el.classList.remove('todo');
        if (el.dataset.legal === 'contact' && el.tagName === 'A') el.href = `mailto:${v}`;
      } else {
        // Left as written in the markup: the visible "à renseigner".
        el.classList.add('todo');
      }
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  else fill();

  // For the tests, and for anything that wants to know without parsing a page.
  window.PanelFlowLegal = LEGAL;
})();
