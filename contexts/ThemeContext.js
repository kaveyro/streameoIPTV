import React, { createContext, useState, useEffect } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const lightTheme = {
  background: '#fff',
  primary: '#1e90ff',
  secondary: '#f0f0f0',
  text: '#000',
  subtleText: '#555',
  border: '#ddd',
  placeholder: '#888',
  danger: '#dc3545',
  header: '#f8f8f8',
  favorite: 'gold',
  favoriteDisabled: '#ccc',
};

export const darkTheme = {
  background: '#121212',
  primary: '#1e90ff',
  secondary: '#1a1a1a',
  text: '#fff',
  subtleText: '#aaa',
  border: '#333',
  placeholder: '#888',
  danger: '#dc3545',
  header: '#121212',
  favorite: 'gold',
  favoriteDisabled: '#444',
};

export const ThemeContext = createContext({
  theme: darkTheme,
  isDarkMode: true,
  toggleTheme: () => {},
});

export const ThemeProvider = ({ children }) => {
  const [isDarkMode, setIsDarkMode] = useState(true);

  useEffect(() => {
    const loadTheme = async () => {
      try {
        const savedTheme = await AsyncStorage.getItem('theme');
        if (savedTheme !== null) {
          setIsDarkMode(savedTheme === 'dark');
        } else {
          setIsDarkMode(Appearance.getColorScheme() === 'dark');
        }
      } catch (e) {
        console.error('Failed to load theme.', e);
        setIsDarkMode(Appearance.getColorScheme() === 'dark');
      }
    };
    loadTheme();
  }, []);

  const toggleTheme = async () => {
    const newIsDarkMode = !isDarkMode;
    setIsDarkMode(newIsDarkMode);
    try {
      await AsyncStorage.setItem('theme', newIsDarkMode ? 'dark' : 'light');
    } catch (e) {
      console.error('Failed to save theme.', e);
    }
  };

  const theme = isDarkMode ? darkTheme : lightTheme;

  return (
    <ThemeContext.Provider value={{ theme, isDarkMode, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};
