document.addEventListener('DOMContentLoaded', () => {
  const navItems = document.querySelectorAll('.nav-item');
  const drawerLeft = document.getElementById('drawer-left');
  const drawerRight = document.getElementById('drawer-right');
  const mainWorkspace = document.getElementById('main-workspace');

  function openDrawer(element, panelId) {
    element.querySelectorAll('.panel-section').forEach(s => s.classList.remove('active'));
    const activeSection = document.getElementById(`panel-${panelId}`);
    if (activeSection) activeSection.classList.add('active');
    element.classList.add('open');
    mainWorkspace.style.opacity = '0.4';
    mainWorkspace.style.cursor = 'pointer'; // Указываем, что сюда можно кликнуть
  }

  function closeAllDrawers() {
    drawerLeft.classList.remove('open');
    drawerRight.classList.remove('open');
    mainWorkspace.style.opacity = '1';
    mainWorkspace.style.cursor = 'default';
  }

  function closeToDashboard() {
    closeAllDrawers();
    navItems.forEach(n => n.classList.remove('active'));
  }

  // Закрытие по клику на затемненный Workspace
  mainWorkspace.addEventListener('click', (e) => {
    if (mainWorkspace.style.opacity === '0.4') {
      e.preventDefault();
      closeToDashboard();
    }
  });

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const panelId = item.getAttribute('data-panel');
      if (item.classList.contains('active')) {
        closeToDashboard();
        return;
      }
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      
      if (item.getAttribute('data-action') === 'open-left') {
        closeAllDrawers();
        openDrawer(drawerLeft, panelId);
      } else if (item.getAttribute('data-action') === 'open-right') {
        closeAllDrawers();
        openDrawer(drawerRight, panelId);
      }
    });
  });

  const btnCloseLeft = document.querySelector('.close-left');
  const btnCloseRight = document.querySelector('.close-right');
  if (btnCloseLeft) btnCloseLeft.addEventListener('click', closeToDashboard);
  if (btnCloseRight) btnCloseRight.addEventListener('click', closeToDashboard);
});