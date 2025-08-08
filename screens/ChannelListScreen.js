import React, { useState, useMemo } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, Image, SafeAreaView } from 'react-native';

export default function ChannelListScreen({ route, navigation }) {
  const { playlist } = route.params;
  const [searchQuery, setSearchQuery] = useState('');

  const filteredPlaylist = useMemo(() => {
    if (!searchQuery) {
      return playlist;
    }
    return playlist.filter(item =>
      item.title.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery, playlist]);

  const groupedData = useMemo(() => {
    const groups = filteredPlaylist.reduce((acc, channel) => {
      const groupName = channel.group || 'Uncategorized';
      if (!acc[groupName]) {
        acc[groupName] = [];
      }
      acc[groupName].push(channel);
      return acc;
    }, {});
    return Object.entries(groups).map(([group, channels]) => ({
      title: group,
      data: channels,
    }));
  }, [filteredPlaylist]);

  const renderChannelItem = ({ item }) => (
    <TouchableOpacity style={styles.item} onPress={() => navigation.navigate('Player', { channel: item })}>
      {item.logo ? (
        <Image source={{ uri: item.logo }} style={styles.logo} />
      ) : (
        <View style={styles.logoPlaceholder}>
          <Text style={styles.logoPlaceholderText}>{item.title.charAt(0)}</Text>
        </View>
      )}
      <Text style={styles.itemText} numberOfLines={1}>{item.title}</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Text style={styles.backButtonText}>←</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Channels</Text>
        </View>
        <TextInput
          style={styles.searchBar}
          placeholder="Search channels..."
          placeholderTextColor="#888"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        <FlatList
          data={filteredPlaylist}
          keyExtractor={(item, index) => item.id ? `channel-${item.id}-${index}` : `channel-index-${index}`}
          renderItem={renderChannelItem}
          ListEmptyComponent={<Text style={styles.emptyText}>No channels found.</Text>}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#121212' },
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  backButton: {
    padding: 5,
    marginRight: 15,
  },
  backButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  searchBar: {
    backgroundColor: '#222',
    color: '#fff',
    padding: 12,
    margin: 15,
    borderRadius: 8,
    fontSize: 16,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    backgroundColor: '#1a1a1a',
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  logo: {
    width: 50,
    height: 50,
    marginRight: 15,
    borderRadius: 8,
    backgroundColor: '#333',
  },
  logoPlaceholder: {
    width: 50,
    height: 50,
    marginRight: 15,
    borderRadius: 8,
    backgroundColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoPlaceholderText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  itemText: {
    color: '#fff',
    fontSize: 16,
    flex: 1,
  },
  emptyText: {
    color: '#777',
    textAlign: 'center',
    marginTop: 50,
    fontSize: 16,
  },
});
